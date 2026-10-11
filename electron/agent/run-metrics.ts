import type { AgentActivityState, AgentOutputTokens, AgentRunMetrics, MetricCoverage } from '../../shared/types/agent-control.js';
import type { AgentOutputProgress } from '../inference/application/agent-inference-port.js';
import type { AIRequestInfo } from '../../shared/types/context.js';
import type { ToolExecutionInterval } from '../tools/pipeline/observe.js';

interface CoverageCounter {
  applicable: number;
  known: number;
}

interface OutputRequest {
  requestId: string;
  runId?: string;
  attempt: number;
  lastSequence: number;
  units: number;
  reportedTokens?: number;
  reportedUnits: number;
}

export function emptyAgentRunMetrics(): AgentRunMetrics {
  return {
    version: 1,
    rounds: 0,
    steps: 0,
    llmDurationMs: 0,
    toolDurationMs: 0,
    firstTokenLatencyTotalMs: 0,
    firstTokenSamples: 0,
    throughputDurationMs: 0,
    throughputOutputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    coverage: {
      toolTiming: 'none',
      firstToken: 'none',
      throughput: 'none',
      inputTokens: 'none',
      outputTokens: 'none',
      cacheReadTokens: 'none',
    },
  };
}

export function emptyAgentActivityState(): AgentActivityState {
  return { runMetrics: emptyAgentRunMetrics() };
}

/** Owns every runtime-only activity clock and aggregate for one loaded Agent. */
export class AgentActivityTracker {
  private readonly completedRequestIds = new Set<string>();
  private readonly settledToolIds = new Set<string>();
  private readonly activeToolIds = new Set<string>();
  private readonly toolIntervals: ToolExecutionInterval[] = [];
  private readonly pendingToolIntervals: ToolExecutionInterval[] = [];
  private readonly coverage = {
    firstToken: counter(),
    throughput: counter(),
    inputTokens: counter(),
    outputTokens: counter(),
    cacheReadTokens: counter(),
  };
  private readonly metrics = emptyAgentRunMetrics();
  private activeStartedAt?: number;
  private activeLlmStartedAt?: number;
  private activeToolPhaseStartedAt?: number;
  private settledOutputTokens?: AgentOutputTokens;
  private outputRequest?: OutputRequest;

  snapshot(): AgentActivityState {
    const activeOutputTokens = this.getOutputTokens();
    return {
      ...(this.activeStartedAt !== undefined && { activeStartedAt: this.activeStartedAt }),
      ...(activeOutputTokens && { activeOutputTokens }),
      ...(this.activeLlmStartedAt !== undefined && { activeLlmStartedAt: this.activeLlmStartedAt }),
      ...(this.activeToolPhaseStartedAt !== undefined && {
        activeToolPhaseStartedAt: this.activeToolPhaseStartedAt,
      }),
      runMetrics: {
        ...this.metrics,
        coverage: {
          toolTiming: this.metrics.steps === 0 ? 'none' : 'complete',
          firstToken: coverageOf(this.coverage.firstToken),
          throughput: coverageOf(this.coverage.throughput),
          inputTokens: coverageOf(this.coverage.inputTokens),
          outputTokens: coverageOf(this.coverage.outputTokens),
          cacheReadTokens: coverageOf(this.coverage.cacheReadTokens),
        },
      },
    };
  }

  aiStarted(startedAt: number, requestId: string): void {
    this.activeStartedAt ??= startedAt;
    this.activeLlmStartedAt = startedAt;
    this.outputRequest = { requestId, attempt: 0, lastSequence: 0, units: 0, reportedUnits: 0 };
  }

  aiProgress(requestId: string, progress: AgentOutputProgress): boolean {
    const current = this.outputRequest;
    if (!current || current.requestId !== requestId) return false;
    const before = this.getOutputTokens();
    if (progress.kind === 'attempt-started') {
      if (current.runId === progress.runId && progress.attempt <= current.attempt) return false;
      // A new gateway run (overflow resend) or attempt replaces this request's contribution.
      current.runId = progress.runId;
      current.attempt = progress.attempt;
      current.lastSequence = 0;
      current.units = 0;
      current.reportedTokens = undefined;
      current.reportedUnits = 0;
    } else {
      if (current.runId !== progress.runId || current.attempt !== progress.attempt
        || progress.sequence <= current.lastSequence) return false;
      current.lastSequence = progress.sequence;
      if (progress.kind === 'delta') {
        current.units += outputTokenUnits(progress.delta);
      } else {
        current.reportedTokens = progress.outputTokens;
        current.reportedUnits = current.units;
      }
    }
    const after = this.getOutputTokens();
    return before?.count !== after?.count || before?.estimated !== after?.estimated;
  }

  aiCompleted(info: AIRequestInfo): void {
    this.activeLlmStartedAt = undefined;
    if (this.outputRequest?.requestId === info.requestId) {
      if (info.usage.outputTokens !== undefined) {
        this.outputRequest.reportedTokens = info.usage.outputTokens;
        this.outputRequest.reportedUnits = this.outputRequest.units;
      }
      this.settleOutput();
    }
    if (this.completedRequestIds.has(info.requestId)) return;
    this.completedRequestIds.add(info.requestId);

    this.metrics.rounds++;
    this.metrics.llmDurationMs += info.latencyMs;
    addOptional(this.coverage.inputTokens, info.usage.inputTokens, (value) => {
      this.metrics.inputTokens += value;
    });
    addOptional(this.coverage.outputTokens, info.usage.outputTokens, (value) => {
      this.metrics.outputTokens += value;
    });
    addCacheUsage(this.coverage.cacheReadTokens, info, (value) => {
      this.metrics.cacheReadTokens += value;
    });

    addOptional(
      this.coverage.firstToken,
      info.firstTokenLatencyMs,
      (value) => {
        this.metrics.firstTokenLatencyTotalMs += value;
        this.metrics.firstTokenSamples++;
      },
    );
    this.coverage.throughput.applicable++;
    if (info.attemptDurationMs !== undefined && info.usage.outputTokens !== undefined) {
      this.coverage.throughput.known++;
      this.metrics.throughputDurationMs += info.attemptDurationMs;
      this.metrics.throughputOutputTokens += info.usage.outputTokens;
    }
  }

  aiStopped(): void {
    this.activeLlmStartedAt = undefined;
    this.settleOutput();
  }

  toolStarted(callId: string, startedAt: number): void {
    this.activeStartedAt ??= startedAt;
    if (this.activeToolIds.size === 0) this.activeToolPhaseStartedAt = startedAt;
    this.activeToolIds.add(callId);
  }

  toolFinished(callId: string, interval: ToolExecutionInterval): void {
    if (interval.finishedAt >= interval.startedAt) this.pendingToolIntervals.push(interval);
    this.activeToolIds.delete(callId);
    if (this.activeToolIds.size !== 0) return;
    this.activeToolPhaseStartedAt = undefined;
    this.commitToolIntervals();
  }

  toolSettled(callId: string): void {
    if (this.settledToolIds.has(callId)) return;
    this.settledToolIds.add(callId);
    this.metrics.steps++;
  }

  activityStopped(): void {
    this.settledOutputTokens = undefined;
    this.outputRequest = undefined;
    this.activeStartedAt = undefined;
    this.activeLlmStartedAt = undefined;
    this.activeToolPhaseStartedAt = undefined;
    this.activeToolIds.clear();
    this.commitToolIntervals();
  }

  private getOutputTokens(): AgentOutputTokens | undefined {
    const current = this.outputRequest;
    const pending = current && (current.units > 0 || current.reportedTokens !== undefined)
      ? {
          count: (current.reportedTokens ?? 0) + Math.ceil((current.units - current.reportedUnits) / 4),
          estimated: current.reportedTokens === undefined || current.units !== current.reportedUnits,
        }
      : undefined;
    return addOutputTokens(this.settledOutputTokens, pending);
  }

  private settleOutput(): void {
    this.settledOutputTokens = this.getOutputTokens();
    this.outputRequest = undefined;
  }

  private commitToolIntervals(): void {
    if (this.pendingToolIntervals.length === 0) return;
    this.toolIntervals.push(...this.pendingToolIntervals.splice(0));
    this.metrics.toolDurationMs = mergedDuration(this.toolIntervals);
  }
}

/** Four ASCII characters or one Unicode code point per estimated token; round after accumulation. */
function outputTokenUnits(delta: string): number {
  let units = 0;
  for (let index = 0; index < delta.length; index++) {
    const code = delta.charCodeAt(index);
    // Ignore the low half so a surrogate pair counts once even across stream chunks.
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    units += code <= 0x7f ? 1 : 4;
  }
  return units;
}

function addOutputTokens(
  left: AgentOutputTokens | undefined,
  right: AgentOutputTokens | undefined,
): AgentOutputTokens | undefined {
  if (!left) return right;
  if (!right) return left;
  return { count: left.count + right.count, estimated: left.estimated || right.estimated };
}

function counter(): CoverageCounter {
  return { applicable: 0, known: 0 };
}

function addOptional(
  coverage: CoverageCounter,
  value: number | undefined,
  add: (value: number) => void,
): void {
  coverage.applicable++;
  if (value === undefined) return;
  coverage.known++;
  add(value);
}

function addCacheUsage(
  coverage: CoverageCounter,
  info: AIRequestInfo,
  add: (value: number) => void,
): void {
  coverage.applicable++;
  const input = info.usage.inputTokens;
  if (input === undefined) return;
  const cached = info.usage.cacheReadTokens ?? 0;
  if (cached > input) return;
  coverage.known++;
  add(cached);
}

function coverageOf(value: CoverageCounter): MetricCoverage {
  if (value.applicable === 0 || value.known === 0) return 'none';
  return value.known === value.applicable ? 'complete' : 'partial';
}

function mergedDuration(intervals: readonly ToolExecutionInterval[]): number {
  const sorted = intervals
    .slice()
    .sort((left, right) => left.startedAt - right.startedAt || left.finishedAt - right.finishedAt);
  let duration = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const interval of sorted) {
    if (start === undefined || end === undefined) {
      start = interval.startedAt;
      end = interval.finishedAt;
    } else if (interval.startedAt <= end) {
      end = Math.max(end, interval.finishedAt);
    } else {
      duration += end - start;
      start = interval.startedAt;
      end = interval.finishedAt;
    }
  }
  return start === undefined || end === undefined ? duration : duration + end - start;
}
