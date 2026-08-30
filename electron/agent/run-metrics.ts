import type { AgentActivityState, AgentRunMetrics, MetricCoverage } from '../../shared/types/agent-control.js';
import type { AIRequestInfo } from '../../shared/types/context.js';
import type { ContentBlock } from '../../shared/types/index.js';
import type { ToolExecutionInterval } from '../tools/pipeline/observe.js';

interface CoverageCounter {
  applicable: number;
  known: number;
}

export function emptyAgentRunMetrics(): AgentRunMetrics {
  return {
    version: 1,
    rounds: 0,
    steps: 0,
    llmDurationMs: 0,
    toolDurationMs: 0,
    firstVisibleContentLatencyTotalMs: 0,
    firstVisibleContentSamples: 0,
    generationDurationMs: 0,
    generationOutputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    coverage: {
      toolTiming: 'none',
      firstVisibleContent: 'none',
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
    firstVisibleContent: counter(),
    throughput: counter(),
    inputTokens: counter(),
    outputTokens: counter(),
    cacheReadTokens: counter(),
  };
  private readonly metrics = emptyAgentRunMetrics();
  private activeStartedAt?: number;
  private activeLlmStartedAt?: number;
  private activeToolPhaseStartedAt?: number;

  snapshot(): AgentActivityState {
    return {
      ...(this.activeStartedAt !== undefined && { activeStartedAt: this.activeStartedAt }),
      ...(this.activeLlmStartedAt !== undefined && { activeLlmStartedAt: this.activeLlmStartedAt }),
      ...(this.activeToolPhaseStartedAt !== undefined && {
        activeToolPhaseStartedAt: this.activeToolPhaseStartedAt,
      }),
      runMetrics: {
        ...this.metrics,
        coverage: {
          toolTiming: this.metrics.steps === 0 ? 'none' : 'complete',
          firstVisibleContent: coverageOf(this.coverage.firstVisibleContent),
          throughput: coverageOf(this.coverage.throughput),
          inputTokens: coverageOf(this.coverage.inputTokens),
          outputTokens: coverageOf(this.coverage.outputTokens),
          cacheReadTokens: coverageOf(this.coverage.cacheReadTokens),
        },
      },
    };
  }

  aiStarted(startedAt: number): void {
    this.activeStartedAt ??= startedAt;
    this.activeLlmStartedAt = startedAt;
  }

  aiCompleted(info: AIRequestInfo, content: readonly ContentBlock[]): void {
    this.activeLlmStartedAt = undefined;
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

    if (!hasVisibleContent(content)) return;
    addOptional(
      this.coverage.firstVisibleContent,
      info.firstVisibleContentLatencyMs,
      (value) => {
        this.metrics.firstVisibleContentLatencyTotalMs += value;
        this.metrics.firstVisibleContentSamples++;
      },
    );
    const throughputKnown = info.generationDurationMs !== undefined
      && info.usage.outputTokens !== undefined;
    this.coverage.throughput.applicable++;
    if (throughputKnown) {
      this.coverage.throughput.known++;
      this.metrics.generationDurationMs += info.generationDurationMs!;
      this.metrics.generationOutputTokens += info.usage.outputTokens!;
    }
  }

  aiStopped(): void {
    this.activeLlmStartedAt = undefined;
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
    this.activeStartedAt = undefined;
    this.activeLlmStartedAt = undefined;
    this.activeToolPhaseStartedAt = undefined;
    this.activeToolIds.clear();
    this.commitToolIntervals();
  }

  private commitToolIntervals(): void {
    if (this.pendingToolIntervals.length === 0) return;
    this.toolIntervals.push(...this.pendingToolIntervals.splice(0));
    this.metrics.toolDurationMs = mergedDuration(this.toolIntervals);
  }
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

function hasVisibleContent(content: readonly ContentBlock[]): boolean {
  return content.some((block) => {
    if (block.type === 'text') return Boolean(block.text);
    if (block.type === 'thinking') return Boolean(block.thinking);
    if (block.type !== 'openai_reasoning') return false;
    return Boolean(
      block.summary?.some((part) => part.text)
      || block.reasoning_content?.some((part) => part.text),
    );
  });
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
