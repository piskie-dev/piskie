import type {
  ConfigApplyReceipt,
  ConfigCapability,
  ConfigDescriptor,
  ConfigDomainAvailability,
  ConfigDomainAvailabilityIssue,
  ConfigDomainLifecycleStage,
  ConfigDomainRevisionChangedEvent,
  ConfigDomainSummary,
  ConfigPatchOperation,
  ConfigPlanRequest,
  ConfigPlanIdentity,
} from '../../../shared/types/config.js';
import type { ConfigDomainAdapter, ConfigProbeInput } from '../contracts/domain.js';
import { resolveConfigFieldChanges } from '../core/field-change-resolver.js';
import { projectConfigWrite } from '../core/schema-write-projector.js';
import type { ConfigDomainRegistry } from '../core/registry.js';

export type ConfigRevisionListener = (event: ConfigDomainRevisionChangedEvent) => void;

export interface ConfigHostLifecycleReport {
  domains: readonly ConfigDomainSummary[];
  allConfigurable: boolean;
  allRuntimeActive: boolean;
}

export interface ConfigDomainErrorContext {
  domain: string;
  issue: ConfigDomainAvailabilityIssue;
}

export interface ConfigHostOptions {
  onSubscriberError?: (error: unknown, event: ConfigDomainRevisionChangedEvent) => void;
  onDomainError?: (error: unknown, context: ConfigDomainErrorContext) => void;
}

export class ConfigHostError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_CAPABILITY_UNSUPPORTED'
      | 'CONFIG_PLAN_NOT_FOUND'
      | 'CONFIG_PLAN_DOMAIN_MISMATCH'
      | 'CONFIG_OPERATION_RESULT_INVALID',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigHostError';
  }
}

export class ConfigHost {
  private readonly planRoutes = new Map<string, string>();
  private readonly listeners = new Set<ConfigRevisionListener>();
  private readonly publishedRevisions = new Map<string, { revision: number; descriptorHash: string }>();
  private readonly availability = new Map<string, ConfigDomainAvailability>();
  private readonly domainPreparations = new Map<string, Promise<void>>();
  private readonly domainActivations = new Map<string, Promise<void>>();
  private preparation?: Promise<ConfigHostLifecycleReport>;
  private initialization?: Promise<ConfigHostLifecycleReport>;
  private recovery?: Promise<void>;

  constructor(
    readonly registry: ConfigDomainRegistry,
    private readonly options: ConfigHostOptions = {},
  ) {}

  async prepare(): Promise<ConfigHostLifecycleReport> {
    if (this.preparation) return this.preparation;
    const preparation = this.prepareDomains();
    this.preparation = preparation;
    try {
      return await preparation;
    } finally {
      if (this.preparation === preparation) this.preparation = undefined;
    }
  }

  async initialize(): Promise<ConfigHostLifecycleReport> {
    if (this.initialization) return this.initialization;
    const initialization = this.initializeDomains();
    this.initialization = initialization;
    try {
      return await initialization;
    } finally {
      if (this.initialization === initialization) this.initialization = undefined;
    }
  }

  domains(): ConfigDomainSummary[] {
    return this.registry.list().map((domain) => ({
      ...domain,
      availability: cloneAvailability(this.currentAvailability(domain.id)),
    }));
  }

  describe(domain: string): ConfigDescriptor {
    return this.registry.describe(domain);
  }

  /** Projects trusted application input through the Domain's current write contract. */
  projectWrite<T = unknown>(domain: string, value: unknown): T {
    const adapter = this.registry.get(domain);
    return projectConfigWrite(adapter.contract.writeSchema, value) as T;
  }

  async show<T = unknown>(domain: string): Promise<T> {
    const adapter = this.requireCapability(domain, 'show');
    await this.ensurePrepared(domain);
    return await adapter.show!() as T;
  }

  async history(domain: string): Promise<readonly number[]> {
    const adapter = this.requireCapability(domain, 'history');
    await this.ensurePrepared(domain);
    return await adapter.history!();
  }

  async createPlan<T extends ConfigPlanIdentity = ConfigPlanIdentity>(
    domain: string,
    request: ConfigPlanRequest,
  ): Promise<T> {
    return this.createPatchPlan(
      domain,
      resolveConfigFieldChanges(this.describe(domain), request),
    );
  }

  /** Internal bridge for trusted application code that already owns typed config fields. */
  async createPatchPlan<T extends ConfigPlanIdentity = ConfigPlanIdentity>(
    domain: string,
    patch: readonly ConfigPatchOperation[],
  ): Promise<T> {
    const adapter = this.requireCapability(domain, 'plan');
    await this.ensurePrepared(domain);
    const plan = await adapter.createPlan!(patch);
    this.assertPlanIdentity(plan, domain);
    this.planRoutes.set(plan.id, domain);
    return plan as T;
  }

  async validate<T = unknown>(planId: string): Promise<T> {
    const adapter = await this.resolvePlanAdapter(planId, 'validate');
    return await adapter.validate!(planId) as T;
  }

  async probe<T = unknown>(planId: string, input: ConfigProbeInput): Promise<T> {
    const adapter = await this.resolvePlanAdapter(planId, 'probe');
    return await adapter.probe!(planId, input) as T;
  }

  async apply<T extends ConfigApplyReceipt = ConfigApplyReceipt>(
    planId: string,
    expectedRevision: number,
  ): Promise<T> {
    const adapter = await this.resolvePlanAdapter(planId, 'apply');
    let receipt: ConfigApplyReceipt;
    try {
      receipt = await adapter.apply!(planId, expectedRevision);
    } catch (cause) {
      if (isPublicationFailure(cause)) {
        this.recordDomainFailure(adapter.contract.id, 'publish', cause);
      }
      throw cause;
    }
    this.assertApplyReceipt(receipt, adapter.contract.id);
    this.recordDomainActive(receipt.domain);
    this.publishRevision(receipt.domain, receipt.revision, 'apply');
    await this.recoverDegradedDomains();
    return receipt as T;
  }

  async verify<T = unknown>(domain: string, expectedRevision?: number): Promise<T> {
    const adapter = this.requireCapability(domain, 'verify');
    await this.ensurePrepared(domain);
    return await adapter.verify!(expectedRevision) as T;
  }

  async rollback<T extends ConfigApplyReceipt = ConfigApplyReceipt>(
    domain: string,
    targetRevision: number,
  ): Promise<T> {
    const adapter = this.requireCapability(domain, 'rollback');
    await this.ensurePrepared(domain);
    let receipt: ConfigApplyReceipt;
    try {
      receipt = await adapter.rollback!(targetRevision);
    } catch (cause) {
      if (isPublicationFailure(cause)) this.recordDomainFailure(domain, 'publish', cause);
      throw cause;
    }
    this.assertApplyReceipt(receipt, domain);
    this.recordDomainActive(receipt.domain);
    this.publishRevision(receipt.domain, receipt.revision, 'rollback');
    await this.recoverDegradedDomains();
    return receipt as T;
  }

  subscribe(listener: ConfigRevisionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishExternalRevision(domain: string, revision: number): boolean {
    return this.publishRevision(domain, revision, 'external');
  }

  async reloadExternal(domain: string): Promise<boolean> {
    const adapter = this.registry.get(domain);
    await this.ensurePrepared(domain);
    if (!adapter.reloadExternal) return false;

    let revision: number | undefined;
    try {
      revision = await adapter.reloadExternal();
    } catch (cause) {
      this.recordDomainFailure(domain, 'reload', cause);
      throw cause;
    }
    this.recordDomainActive(domain);
    const changed = revision === undefined ? false : this.publishExternalRevision(domain, revision);
    await this.recoverDegradedDomains();
    return changed;
  }

  private requireCapability(domain: string, capability: ConfigCapability): ConfigDomainAdapter {
    const adapter = this.registry.get(domain);
    if (!adapter.contract.capabilities.includes(capability)) {
      throw new ConfigHostError(
        'CONFIG_CAPABILITY_UNSUPPORTED',
        `Config domain ${domain} does not support ${capability}`,
        { domain, capability },
      );
    }
    return adapter;
  }

  private async prepareDomains(): Promise<ConfigHostLifecycleReport> {
    await Promise.all(this.registry.list().map(async ({ id }) => {
      try {
        await this.ensurePrepared(id);
      } catch {
        // A failed Domain remains unavailable without hiding healthy Domains.
      }
    }));
    return this.lifecycleReport();
  }

  private async initializeDomains(): Promise<ConfigHostLifecycleReport> {
    await this.prepare();
    for (const { id } of this.registry.list()) {
      if (!this.currentAvailability(id).configurable) continue;
      try {
        await this.activateDomain(id);
      } catch {
        // Activation is isolated per Domain; its issue is exposed by domains().
      }
    }
    return this.lifecycleReport();
  }

  private async ensurePrepared(domain: string): Promise<void> {
    this.registry.get(domain);
    if (this.currentAvailability(domain).configurable) return;
    const pending = this.domainPreparations.get(domain);
    if (pending) return pending;

    const preparation = this.prepareDomain(domain);
    this.domainPreparations.set(domain, preparation);
    try {
      await preparation;
    } finally {
      if (this.domainPreparations.get(domain) === preparation) {
        this.domainPreparations.delete(domain);
      }
    }
  }

  private async prepareDomain(domain: string): Promise<void> {
    try {
      await this.registry.get(domain).prepare?.();
      const current = this.currentAvailability(domain);
      this.availability.set(domain, {
        state: current.state === 'active' || current.state === 'degraded'
          ? current.state
          : 'ready',
        configurable: true,
        runtimeActive: current.runtimeActive,
        ...(current.state === 'degraded' && current.issue ? { issue: current.issue } : {}),
      });
    } catch (cause) {
      this.recordDomainFailure(domain, 'prepare', cause);
      throw cause;
    }
  }

  private async activateDomain(domain: string): Promise<void> {
    if (this.currentAvailability(domain).state === 'active') return;
    const pending = this.domainActivations.get(domain);
    if (pending) return pending;

    const activation = this.runDomainActivation(domain);
    this.domainActivations.set(domain, activation);
    try {
      await activation;
    } finally {
      if (this.domainActivations.get(domain) === activation) {
        this.domainActivations.delete(domain);
      }
    }
  }

  private async runDomainActivation(domain: string): Promise<void> {
    await this.ensurePrepared(domain);
    try {
      await this.registry.get(domain).activate?.();
      this.recordDomainActive(domain);
    } catch (cause) {
      this.recordDomainFailure(domain, 'activate', cause);
      throw cause;
    }
  }

  private async recoverDegradedDomains(): Promise<void> {
    if (this.recovery) return this.recovery;
    const recovery = this.runDegradedRecovery();
    this.recovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.recovery === recovery) this.recovery = undefined;
    }
  }

  private async runDegradedRecovery(): Promise<void> {
    const limit = this.registry.list().length;
    for (let pass = 0; pass < limit; pass++) {
      const degraded = this.domains()
        .filter((domain) => domain.availability.state === 'degraded')
        .map((domain) => domain.id);
      if (degraded.length === 0) return;

      let recovered = 0;
      for (const domain of degraded) {
        try {
          await this.activateDomain(domain);
          recovered++;
        } catch {
          // Keep the latest structured issue and retry only after another Domain recovers.
        }
      }
      if (recovered === 0) return;
    }
  }

  private lifecycleReport(): ConfigHostLifecycleReport {
    const domains = this.domains();
    return {
      domains,
      allConfigurable: domains.every((domain) => domain.availability.configurable),
      allRuntimeActive: domains.every((domain) => domain.availability.runtimeActive),
    };
  }

  private currentAvailability(domain: string): ConfigDomainAvailability {
    return this.availability.get(domain) ?? {
      state: 'uninitialized',
      configurable: false,
      runtimeActive: false,
    };
  }

  private recordDomainActive(domain: string): void {
    this.availability.set(domain, {
      state: 'active',
      configurable: true,
      runtimeActive: true,
    });
  }

  private recordDomainFailure(
    domain: string,
    stage: ConfigDomainLifecycleStage,
    cause: unknown,
  ): void {
    const current = this.currentAvailability(domain);
    const unavailable = stage === 'prepare' || isConfigUnavailable(domain, cause);
    const issue = domainIssue(stage, cause);
    this.availability.set(domain, {
      state: unavailable ? 'unavailable' : 'degraded',
      configurable: !unavailable,
      runtimeActive: current.runtimeActive,
      issue,
    });
    try {
      this.options.onDomainError?.(cause, { domain, issue });
    } catch {
      // Diagnostics cannot turn an isolated Domain failure into a Host failure.
    }
  }

  private async resolvePlanAdapter(
    planId: string,
    capability: Extract<ConfigCapability, 'validate' | 'probe' | 'apply'>,
  ): Promise<ConfigDomainAdapter> {
    const cachedDomain = this.planRoutes.get(planId);
    const registeredDomains = this.registry.list().map((domain) => domain.id);
    const domainIds = cachedDomain
      ? [cachedDomain, ...registeredDomains.filter((domain) => domain !== cachedDomain)]
      : registeredDomains;

    for (const domain of domainIds) {
      const adapter = this.registry.get(domain);
      if (!adapter.locatePlan) continue;
      try {
        await this.ensurePrepared(domain);
      } catch (cause) {
        if (domain === cachedDomain) throw cause;
        continue;
      }
      const plan = await adapter.locatePlan(planId);
      if (!plan) continue;
      this.assertPlanIdentity(plan, adapter.contract.id);
      this.planRoutes.set(planId, adapter.contract.id);
      return this.requireCapability(adapter.contract.id, capability);
    }

    throw new ConfigHostError(
      'CONFIG_PLAN_NOT_FOUND',
      `Config plan was not found in any registered domain: ${planId}`,
      { planId },
    );
  }

  private publishRevision(
    domain: string,
    revision: number,
    source: ConfigDomainRevisionChangedEvent['source'],
  ): boolean {
    if (!Number.isInteger(revision) || revision < 0) {
      throw new ConfigHostError(
        'CONFIG_OPERATION_RESULT_INVALID',
        `Config domain ${domain} returned an invalid revision`,
        { domain, revision },
      );
    }
    const descriptorHash = this.registry.describe(domain).descriptorHash;
    const previous = this.publishedRevisions.get(domain);
    if (previous && (
      revision < previous.revision
      || (revision === previous.revision && descriptorHash === previous.descriptorHash)
    )) return false;

    const event: ConfigDomainRevisionChangedEvent = {
      domain,
      revision,
      descriptorHash,
      source,
    };
    this.publishedRevisions.set(domain, { revision, descriptorHash });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.options.onSubscriberError?.(error, event);
        } catch {
          // A diagnostic callback must not turn a committed config change into a failure.
        }
      }
    }
    return true;
  }

  private assertPlanIdentity(plan: ConfigPlanIdentity, expectedDomain: string): void {
    if (typeof plan?.id !== 'string'
      || !plan.id
      || typeof plan.domain !== 'string'
      || !Number.isInteger(plan.baseRevision)
      || plan.baseRevision < 0) {
      throw new ConfigHostError(
        'CONFIG_OPERATION_RESULT_INVALID',
        `Config domain ${expectedDomain} returned an invalid Plan identity`,
        { domain: expectedDomain },
      );
    }
    if (plan.domain !== expectedDomain) {
      throw new ConfigHostError(
        'CONFIG_PLAN_DOMAIN_MISMATCH',
        `Config plan ${plan.id} belongs to ${plan.domain}, not ${expectedDomain}`,
        { planId: plan.id, actualDomain: plan.domain, expectedDomain },
      );
    }
  }

  private assertApplyReceipt(receipt: ConfigApplyReceipt, expectedDomain: string): void {
    if (!receipt || typeof receipt.domain !== 'string' || !Number.isInteger(receipt.revision)) {
      throw new ConfigHostError(
        'CONFIG_OPERATION_RESULT_INVALID',
        `Config domain ${expectedDomain} returned an invalid Apply receipt`,
        { domain: expectedDomain },
      );
    }
    if (receipt.domain !== expectedDomain) {
      throw new ConfigHostError(
        'CONFIG_PLAN_DOMAIN_MISMATCH',
        `Config receipt belongs to ${receipt.domain}, not ${expectedDomain}`,
        { actualDomain: receipt.domain, expectedDomain },
      );
    }
  }
}

function cloneAvailability(availability: ConfigDomainAvailability): ConfigDomainAvailability {
  return {
    ...availability,
    ...(availability.issue && {
      issue: {
        ...availability.issue,
        ...(availability.issue.details && { details: { ...availability.issue.details } }),
      },
    }),
  };
}

function domainIssue(
  stage: ConfigDomainLifecycleStage,
  cause: unknown,
): ConfigDomainAvailabilityIssue {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const record = isRecord(cause) ? cause : {};
  return {
    stage,
    code: typeof record.code === 'string' ? record.code : 'CONFIG_DOMAIN_LIFECYCLE_FAILED',
    message: error.message,
    ...(isRecord(record.details) && { details: record.details }),
  };
}

function isPublicationFailure(cause: unknown): boolean {
  if (!isRecord(cause)) return false;
  return cause.code === 'CONFIG_PUBLICATION_FAILED'
    || (isRecord(cause.details) && cause.details.persisted === true);
}

function isConfigUnavailable(domain: string, cause: unknown): boolean {
  if (!isRecord(cause) || typeof cause.code !== 'string') return false;
  const unavailable = cause.code === 'CONFIG_INVALID'
    || cause.code === 'CONFIG_NOT_FOUND'
    || cause.code === 'CONFIG_READ_FAILED';
  if (!unavailable) return false;
  return !isRecord(cause.details)
    || typeof cause.details.domain !== 'string'
    || cause.details.domain === domain;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
