import type { AgentRunMetrics, MetricCoverage } from '../../../../shared/types/agent-control';

export interface AgentMetricLabels {
  readonly rounds: string;
  readonly steps: string;
  readonly llm: string;
  readonly tools: string;
  readonly firstVisible: string;
  readonly throughput: string;
  readonly cache: string;
  readonly input: string;
  readonly output: string;
}

function covered(coverage: MetricCoverage, value: string): string {
  return coverage === 'complete' ? value : '—';
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function formatCount(value: number, locale: string): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return new Intl.NumberFormat(locale).format(value);
}

interface AgentMetricLabelOptions {
  readonly locale: string;
  readonly rounds: (count: number) => string;
  readonly steps: (count: number) => string;
}

function activeDuration(settled: number, startedAt: number | undefined, now: number): number {
  return settled + (startedAt === undefined ? 0 : Math.max(0, now - startedAt));
}

export function agentMetricLabels(
  metrics: AgentRunMetrics,
  now: number,
  activeLlmStartedAt: number | undefined,
  activeToolPhaseStartedAt: number | undefined,
  options: AgentMetricLabelOptions,
): AgentMetricLabels {
  const llmDuration = activeDuration(metrics.llmDurationMs, activeLlmStartedAt, now);
  const toolDuration = activeDuration(metrics.toolDurationMs, activeToolPhaseStartedAt, now);
  const firstVisible = metrics.firstVisibleContentSamples > 0
    ? formatDuration(metrics.firstVisibleContentLatencyTotalMs / metrics.firstVisibleContentSamples)
    : '—';
  const throughput = metrics.generationDurationMs > 0
    ? `${Math.round(metrics.generationOutputTokens / (metrics.generationDurationMs / 1000))} tok/s`
    : '—';
  const cache = metrics.inputTokens > 0
    ? `${Math.round((metrics.cacheReadTokens / metrics.inputTokens) * 100)}%`
    : '—';

  return {
    rounds: options.rounds(metrics.rounds),
    steps: options.steps(metrics.steps),
    llm: formatDuration(llmDuration),
    tools: metrics.steps === 0
      ? formatDuration(toolDuration)
      : covered(metrics.coverage.toolTiming, formatDuration(toolDuration)),
    firstVisible: covered(metrics.coverage.firstVisibleContent, firstVisible),
    throughput: covered(metrics.coverage.throughput, throughput),
    cache: covered(metrics.coverage.cacheReadTokens, cache),
    input: covered(metrics.coverage.inputTokens, formatCount(metrics.inputTokens, options.locale)),
    output: covered(metrics.coverage.outputTokens, formatCount(metrics.outputTokens, options.locale)),
  };
}
