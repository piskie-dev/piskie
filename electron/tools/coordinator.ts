import { PendingSettlement } from '../agent/tool-call/pending-settlement.js';
import type { ToolCallContextFactory } from '../agent/tool-call/context-builder.js';
import type { CatalogEntry, CatalogSnapshot } from './catalog.js';
import { parse } from './params.js';
import { InvariantViolation } from './pipeline/invariant-violation.js';
import {
  loggingToolObserver,
  observe,
  safelyNotifyToolObserver,
  type ToolExecutionInterval,
  type ToolObserver,
} from './pipeline/observe.js';
import { REJECT } from './pipeline/rejections.js';
import { ADMIT, FINALIZE, PREPARE } from './pipeline/steps.js';
import type {
  PipelineRuntime,
  PrepareDraft,
} from './pipeline/types.js';
import {
  isToolSuspension,
  toToolResult,
  type PreparedCall,
  type RawCall,
  type Rejection,
  type TerminalReason,
  type ToolContext,
  type ToolOutput,
  type ToolSuspension,
} from './types.js';

export interface SkillInventoryPort {
  classify(skill: string): Promise<'standard' | 'disabled' | 'unknown'>;
}

export type ToolCoordinatorOptions = Readonly<{
  contexts: ToolCallContextFactory;
  pipeline?: PipelineRuntime;
  observer?: ToolObserver;
  skills?: SkillInventoryPort;
}>;

type CompletedRun = Readonly<{
  kind: 'completed';
  pending: PendingSettlement;
  effectiveName: string;
  observation: 'ok' | 'error' | 'rejected';
  data?: unknown;
}>;
type SuspendedRun = Readonly<{
  kind: 'suspended';
  suspension: ToolSuspension;
  effectiveName: string;
}>;
type CoordinatorRun = CompletedRun | SuspendedRun;

type EffectiveCall = Readonly<{
  entry: CatalogEntry;
  rawParams: unknown;
}>;

type SkillSelectorParams = {
  skill: string;
  function: string;
  args?: unknown;
};

/** The sole execution entry for every model-facing tool call. */
export class ToolCoordinator {
  private readonly observer: ToolObserver;
  private readonly pipeline: PipelineRuntime;

  constructor(private readonly options: ToolCoordinatorOptions) {
    this.observer = options.observer ?? loggingToolObserver;
    this.pipeline = options.pipeline ?? {};
  }

  async run(
    raw: RawCall,
    snapshot: CatalogSnapshot,
    loadedDeferred?: ReadonlySet<string>,
  ): Promise<PendingSettlement | ToolSuspension> {
    const intervals: ToolExecutionInterval[] = [];
    const run = await observe(
      raw,
      this.observer,
      () => this.runObserved(raw, snapshot, intervals, loadedDeferred),
      (value) => value.kind === 'suspended'
        ? { effectiveName: value.effectiveName, outcome: 'suspended' as const, intervals }
        : {
            effectiveName: value.effectiveName,
            outcome: value.observation,
            result: value.pending.result,
            data: value.data,
            intervals,
          },
    );
    return run.kind === 'suspended' ? run.suspension : run.pending;
  }

  private async runObserved(
    raw: RawCall,
    snapshot: CatalogSnapshot,
    intervals: ToolExecutionInterval[],
    loadedDeferred?: ReadonlySet<string>,
  ): Promise<CoordinatorRun> {
    let effective: EffectiveCall | Rejection;
    try {
      effective = await this.resolveEffectiveCall(raw, snapshot, loadedDeferred);
    } catch (error) {
      if (error instanceof InvariantViolation) throw error;
      return this.failed(raw, raw.modelName, error);
    }
    if ('text' in effective) {
      return this.rejected(raw.callId, raw.modelName, effective);
    }

    const { entry } = effective;
    let terminal: TerminalReason | undefined;
    const declareTerminal = (reason: TerminalReason): void => {
      if (!entry.tool.def.policy?.exclusive) {
        throw new InvariantViolation(REJECT.mustBeExclusive(entry.modelName));
      }
      if (terminal !== undefined) {
        throw new InvariantViolation(`${entry.modelName} 同一次调用两次声明终态`);
      }
      terminal = reason;
    };

    let call: PreparedCall<unknown>;
    let ctx: ToolContext | undefined;
    try {
      ctx = this.options.contexts.create(entry, raw.callId, declareTerminal, snapshot);
      const draft: PrepareDraft = {
        modelName: entry.modelName,
        rawParams: effective.rawParams,
        callId: raw.callId,
        entry,
        ctx,
      };
      for (const step of PREPARE) {
        const rejection = step(draft);
        if (rejection) return this.rejected(raw.callId, entry.modelName, rejection);
      }
      if (draft.params === undefined) {
        throw new InvariantViolation(`PREPARE did not populate params for ${entry.modelName}`);
      }
      call = draft as PreparedCall<unknown>;

      for (const step of ADMIT) {
        const rejection = await step(call, this.pipeline);
        if (rejection) return this.rejected(raw.callId, entry.modelName, rejection);
      }

      const output = await this.executeTool(raw, entry, call, intervals);
      if (isToolSuspension(output)) {
        return { kind: 'suspended', suspension: output, effectiveName: entry.modelName };
      }

      const result = toToolResult(output);
      for (const step of FINALIZE) await step(call, result);
      return {
        kind: 'completed',
        pending: new PendingSettlement(
          raw.callId,
          entry.modelName,
          result,
          terminal,
          output.artifacts,
        ),
        effectiveName: entry.modelName,
        observation: output.ok ? 'ok' : 'error',
        data: output.data,
      };
    } catch (error) {
      if (error instanceof InvariantViolation) throw error;
      return this.failed(raw, entry.modelName, error);
    } finally {
      ctx?.spool?.dispose();
    }
  }

  private async executeTool(
    raw: RawCall,
    entry: CatalogEntry,
    call: PreparedCall<unknown>,
    intervals: ToolExecutionInterval[],
  ): Promise<ToolOutput<unknown> | ToolSuspension> {
    if (entry.modelName === 'ask_user') {
      return await entry.tool.execute(call.params, call.ctx) as ToolOutput<unknown> | ToolSuspension;
    }
    const startedAt = Date.now();
    safelyNotifyToolObserver(raw, 'execution-started', () => {
      this.observer.executionStarted?.(raw, startedAt);
    });
    try {
      return await entry.tool.execute(call.params, call.ctx) as ToolOutput<unknown> | ToolSuspension;
    } finally {
      const interval = { startedAt, finishedAt: Date.now() };
      intervals.push(interval);
      safelyNotifyToolObserver(raw, 'execution-finished', () => {
        this.observer.executionFinished?.(raw, interval);
      });
    }
  }

  private async resolveEffectiveCall(
    raw: RawCall,
    snapshot: CatalogSnapshot,
    loadedDeferred?: ReadonlySet<string>,
  ): Promise<EffectiveCall | Rejection> {
    const direct = snapshot.resolve(raw.modelName);
    if (!direct) {
      const deferred = snapshot.resolveDeferred(raw.modelName);
      if (deferred) {
        if (loadedDeferred?.has(raw.modelName)) {
          return { entry: deferred, rawParams: raw.rawParams };
        }
        return { text: REJECT.deferredNotLoaded(raw.modelName) };
      }
      return {
        text: REJECT.unknownTool(
          raw.modelName,
          snapshot.definitions(loadedDeferred).map((definition) => definition.name),
        ),
      };
    }
    if (raw.modelName !== 'skill_call') return { entry: direct, rawParams: raw.rawParams };

    const parsed = parse(direct.tool.def.schema, raw.rawParams);
    if (!parsed.ok) return { text: REJECT.shapeViolation(parsed.errors) };
    const selector = parsed.value as SkillSelectorParams;
    const resolved = snapshot.resolveSkillFunction(selector.skill, selector.function);
    switch (resolved.kind) {
      case 'resolved':
        return { entry: resolved.entry, rawParams: selector.args ?? {} };
      case 'directOnly':
        return { text: REJECT.directOnly(resolved.modelName) };
      case 'unknownFunction':
        return {
          text: REJECT.unknownFunction(selector.skill, selector.function, resolved.available),
        };
      case 'notEligible':
        return {
          text: REJECT.notEligible(selector.skill, selector.function, resolved.reason),
        };
      case 'notCallable': {
        const classification = await this.options.skills?.classify(selector.skill) ?? 'unknown';
        if (classification === 'standard') return { text: REJECT.standardSkill(selector.skill) };
        if (classification === 'disabled') return { text: REJECT.disabledSkill(selector.skill) };
        return { text: REJECT.unknownSkill(selector.skill) };
      }
    }
  }

  private rejected(callId: string, toolName: string, rejection: Rejection): CompletedRun {
    return {
      kind: 'completed',
      pending: new PendingSettlement(callId, toolName, { ok: false, text: rejection.text }),
      effectiveName: toolName,
      observation: 'rejected',
    };
  }

  private failed(raw: RawCall, toolName: string, error: unknown): CompletedRun {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: 'completed',
      pending: new PendingSettlement(raw.callId, toolName, {
        ok: false,
        text: REJECT.executionFailed(toolName, reason),
      }),
      effectiveName: toolName,
      observation: 'error',
    };
  }
}
