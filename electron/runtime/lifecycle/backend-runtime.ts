import { createUuid } from '@shared/utils/identifiers.js';

import {
  createComponentManifest,
  type ComponentManifest,
  type RuntimeComponent,
  type StopContext,
} from '../component-manifest.js';
import { settleWithDeadline } from './deadline.js';
import { ResourceLedger, type ResourceCloseResult } from './resource-ledger.js';
import { ResourceScope } from './resource-scope.js';
import {
  BackendLifecycleError,
  BackendStartError,
  serializeDiagnostic,
  type BackendPhase,
  type BackendSnapshot,
  type BootReport,
  type CapabilityUnavailable,
  type ComponentBootResult,
  type ComponentStopResult,
  type ComponentVerificationResult,
  type ShutdownReport,
  type StartupFailureReport,
} from './runtime-state.js';

interface StartedComponent {
  component: RuntimeComponent;
  ready: unknown;
  scope: ResourceScope;
}

interface AttemptedComponent {
  component: RuntimeComponent;
  ready: unknown | undefined;
  scope: ResourceScope;
}

export interface BackendRuntimeOptions<Capabilities extends object> {
  components: readonly RuntimeComponent[];
  createCapabilities(ready: ReadonlyMap<string, unknown>): Capabilities;
  generation?: string;
  stopTimeoutMs?: number;
  now?: () => number;
}

export class BackendRuntime<Capabilities extends object> {
  readonly generation: string;

  private readonly manifest: ComponentManifest;
  private readonly ledger: ResourceLedger;
  private readonly createCapabilities: BackendRuntimeOptions<Capabilities>['createCapabilities'];
  private readonly stopTimeoutMs: number;
  private readonly now: () => number;
  private readonly startController = new AbortController();
  private readonly started: StartedComponent[] = [];
  private readonly completedAttempts: AttemptedComponent[] = [];
  private readonly cleanedAttempts = new Set<AttemptedComponent>();
  private readonly readyById = new Map<string, unknown>();
  private degraded: CapabilityUnavailable[] = [];
  private phase: BackendPhase = 'created';
  private startedAt?: number;
  private readyAt?: number;
  private stoppingAt?: number;
  private terminalAt?: number;
  private capabilitySet?: Readonly<Capabilities>;
  private startPromise?: Promise<BootReport>;
  private stopPromise?: Promise<ShutdownReport>;

  constructor(options: BackendRuntimeOptions<Capabilities>) {
    this.generation = options.generation ?? createUuid();
    this.manifest = createComponentManifest(options.components);
    this.ledger = new ResourceLedger(this.generation);
    this.createCapabilities = options.createCapabilities;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  snapshot(): BackendSnapshot {
    return Object.freeze({
      generation: this.generation,
      phase: this.phase,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      stoppingAt: this.stoppingAt,
      terminalAt: this.terminalAt,
      degradedCapabilities: Object.freeze([...this.degraded]),
    });
  }

  start(): Promise<BootReport> {
    if (this.phase === 'starting' && this.startPromise) return this.startPromise;
    if (this.phase !== 'created') {
      return Promise.reject(new BackendLifecycleError(
        `Backend generation ${this.generation} cannot start from ${this.phase}`,
      ));
    }
    this.phase = 'starting';
    this.startedAt = this.now();
    this.startPromise = this.startNow();
    return this.startPromise;
  }

  capabilities(): Readonly<Capabilities> {
    if (this.phase !== 'ready' || !this.capabilitySet) {
      throw new BackendLifecycleError(`Backend capabilities are unavailable in ${this.phase}`);
    }
    return this.capabilitySet;
  }

  stop(reason: string): Promise<ShutdownReport> {
    if (this.phase === 'stopping' && this.stopPromise) return this.stopPromise;
    if (this.phase === 'starting' && this.startPromise) {
      this.startController.abort(reason);
      this.stopPromise ??= this.startPromise.then(
        () => this.stopNow(reason),
        (error) => Promise.reject(error),
      );
      return this.stopPromise;
    }
    if (this.phase !== 'ready') {
      return Promise.reject(new BackendLifecycleError(
        `Backend generation ${this.generation} cannot stop from ${this.phase}`,
      ));
    }
    this.stopPromise = this.stopNow(reason);
    return this.stopPromise;
  }

  private async startNow(): Promise<BootReport> {
    const componentResults: ComponentBootResult[] = [];

    for (const layer of this.manifest.layers) {
      const completionOrder: StartedComponent[] = [];
      const settled = await Promise.all(layer.map(async (component) => {
        const scope = new ResourceScope(
          this.generation,
          `component:${component.id}`,
          this.ledger,
          this.startController.signal,
        );
        const attempted: AttemptedComponent = { component, ready: undefined, scope };
        const componentStartedAt = this.now();
        try {
          const ready = await component.start({
            generation: this.generation,
            startedAt: this.startedAt!,
            signal: scope.signal,
          }, scope);
          attempted.ready = ready;
          const record = { component, ready, scope };
          completionOrder.push(record);
          componentResults.push({
            componentId: component.id,
            requirement: component.requirement,
            outcome: 'ready',
            durationMs: this.now() - componentStartedAt,
          });
          return { status: 'ready' as const, record };
        } catch (error) {
          if (component.requirement === 'required' && !this.startController.signal.aborted) {
            // Wake same-layer starters before waiting for the whole layer to settle.
            this.startController.abort(error);
          }
          return {
            status: 'failed' as const,
            component,
            attempted,
            error,
            durationMs: this.now() - componentStartedAt,
          };
        } finally {
          this.completedAttempts.push(attempted);
        }
      }));

      this.started.push(...completionOrder);
      for (const record of completionOrder) {
        this.readyById.set(record.component.id, record.ready);
      }

      const failures = settled.filter((item) => item.status === 'failed');
      let fatal: typeof failures[number] | undefined;
      for (const failure of failures) {
        if (failure.component.requirement === 'required') {
          componentResults.push({
            componentId: failure.component.id,
            requirement: 'required',
            outcome: 'failed',
            durationMs: failure.durationMs,
            error: serializeDiagnostic(failure.error),
          });
          fatal ??= failure;
          continue;
        }
        const cleanup = await this.stopAttempt(failure.attempted, 'optional-start-failed');
        this.cleanedAttempts.add(failure.attempted);
        const verification = await this.verifyComponent(failure.component);
        const residuals = await failure.attempted.scope.residuals();
        const clean = cleanup.outcome === 'stopped'
          && verification.state === 'stopped'
          && residuals.length === 0;
        if (!clean) {
          componentResults.push({
            componentId: failure.component.id,
            requirement: 'optional',
            outcome: 'failed',
            durationMs: failure.durationMs,
            error: serializeDiagnostic(failure.error),
          });
          fatal ??= failure;
          continue;
        }
        const diagnostic = serializeDiagnostic(failure.error);
        this.degraded.push({ componentId: failure.component.id, reason: diagnostic });
        componentResults.push({
          componentId: failure.component.id,
          requirement: 'optional',
          outcome: 'unavailable',
          durationMs: failure.durationMs,
          error: diagnostic,
        });
      }

      if (fatal) {
        if (!this.startController.signal.aborted) this.startController.abort(fatal.error);
        throw await this.rollbackStartup(
          this.startController.signal.reason ?? fatal.error,
          componentResults,
        );
      }
      if (this.startController.signal.aborted) {
        throw await this.rollbackStartup(
          this.startController.signal.reason ?? new Error('Backend startup was cancelled'),
          componentResults,
        );
      }
    }

    try {
      this.capabilitySet = Object.freeze(this.createCapabilities(this.readyById));
    } catch (error) {
      throw await this.rollbackStartup(error, componentResults);
    }

    this.readyAt = this.now();
    this.phase = 'ready';
    return Object.freeze({
      generation: this.generation,
      phase: 'ready',
      startedAt: this.startedAt!,
      readyAt: this.readyAt,
      components: Object.freeze([...componentResults]),
      degradedCapabilities: Object.freeze([...this.degraded]),
    });
  }

  private async rollbackStartup(
    cause: unknown,
    componentResults: readonly ComponentBootResult[],
  ): Promise<BackendStartError> {
    const rollback: ComponentStopResult[] = [];
    // Completion order, rather than launch order, is the only reliable rollback order
    // for components started concurrently in the same dependency layer.
    for (const attempted of [...this.completedAttempts].reverse()) {
      if (this.cleanedAttempts.has(attempted)) continue;
      rollback.push(await this.stopAttempt(attempted, 'startup-rollback'));
      this.cleanedAttempts.add(attempted);
    }
    const resourceClose = await this.ledger.closeAll('startup-rollback', this.stopTimeoutMs);
    const verification = await this.verifyAll();
    const { residuals } = await this.ledger.assertEmpty();
    const clean = rollback.every((result) => result.outcome === 'stopped')
      && resourceClose.every((result) => result.outcome === 'closed')
      && verification.every((result) => result.state === 'stopped')
      && residuals.length === 0;

    this.phase = clean ? 'failed-start' : 'quarantined';
    this.terminalAt = this.now();
    const report: StartupFailureReport = Object.freeze({
      generation: this.generation,
      phase: this.phase,
      startedAt: this.startedAt!,
      failedAt: this.terminalAt,
      cause: serializeDiagnostic(cause),
      components: Object.freeze([...componentResults]),
      rollback: Object.freeze(rollback),
      verification: Object.freeze(verification),
      residualResources: Object.freeze([...residuals]),
    });
    return new BackendStartError(report);
  }

  private async stopNow(reason: string): Promise<ShutdownReport> {
    this.phase = 'stopping';
    this.stoppingAt = this.now();
    const results: ComponentStopResult[] = [];

    for (const record of [...this.started].reverse()) {
      results.push(await this.stopAttempt(record, reason));
    }

    const resourceResults = await this.ledger.closeAll(reason, this.stopTimeoutMs);
    const verification = await this.verifyAll();
    const { residuals } = await this.ledger.assertEmpty();
    const hasResidual = residuals.length > 0
      || verification.some((result) => result.state !== 'stopped')
      || resourceResults.some((result) => isResidualResourceResult(result));
    const hasStopFailure = results.some((result) => result.outcome !== 'stopped')
      || resourceResults.some((result) => result.outcome !== 'closed');

    this.phase = hasResidual
      ? 'quarantined'
      : hasStopFailure
        ? 'failed-stop'
        : 'stopped';
    this.terminalAt = this.now();

    return Object.freeze({
      generation: this.generation,
      phase: this.phase,
      requestedAt: this.stoppingAt,
      finishedAt: this.terminalAt,
      reason,
      components: Object.freeze(results),
      verification: Object.freeze(verification),
      residualResources: Object.freeze([...residuals]),
    });
  }

  private async stopAttempt(
    attempted: AttemptedComponent,
    reason: string,
  ): Promise<ComponentStopResult> {
    const { component, ready, scope } = attempted;
    const timeoutMs = component.stopTimeoutMs ?? this.stopTimeoutMs;
    const controller = new AbortController();
    const context: StopContext = {
      generation: this.generation,
      reason,
      deadlineAt: this.now() + timeoutMs,
      signal: controller.signal,
    };
    const result = await settleWithDeadline(() => component.stop(context, ready), timeoutMs);
    if (result.outcome === 'timed-out') {
      controller.abort('stop-timeout');
      if (component.forceClose) {
        await settleWithDeadline(() => component.forceClose!(context, ready), timeoutMs);
      }
    }
    const resourceResults = await scope.close(reason, timeoutMs);
    const resourceFailed = resourceResults.some((item) => item.outcome !== 'closed');

    if (result.outcome === 'timed-out') {
      return { componentId: component.id, outcome: 'timed-out', durationMs: result.durationMs };
    }
    if (result.outcome === 'failed') {
      return {
        componentId: component.id,
        outcome: 'failed',
        durationMs: result.durationMs,
        error: serializeDiagnostic(result.error),
      };
    }
    if (resourceFailed) {
      return {
        componentId: component.id,
        outcome: 'failed',
        durationMs: result.durationMs,
        error: { name: 'ResourceCloseError', message: 'Component resources did not close cleanly' },
      };
    }
    return { componentId: component.id, outcome: 'stopped', durationMs: result.durationMs };
  }

  private async verifyAll(): Promise<ComponentVerificationResult[]> {
    return Promise.all(this.manifest.components.map((component) => this.verifyComponent(component)));
  }

  private async verifyComponent(
    component: RuntimeComponent,
  ): Promise<ComponentVerificationResult> {
    try {
      const result = await component.verifyStopped({ generation: this.generation });
      return { componentId: component.id, state: result.state, details: result.details };
    } catch (error) {
      return {
        componentId: component.id,
        state: 'unknown',
        error: serializeDiagnostic(error),
      };
    }
  }
}

function isResidualResourceResult(result: ResourceCloseResult): boolean {
  return result.outcome === 'still-live' || result.outcome === 'unknown';
}
