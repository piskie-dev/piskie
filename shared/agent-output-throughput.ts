import type { AgentRunMetrics } from './types/agent-control.js';

/** Average output tokens per second over paired, complete final-attempt samples. */
export function averageOutputThroughput(metrics: readonly AgentRunMetrics[]): number | undefined {
  let durationMs = 0;
  let outputTokens = 0;
  for (const metric of metrics) {
    if (metric.rounds === 0) continue;
    if (metric.coverage.throughput !== 'complete') return undefined;
    durationMs += metric.throughputDurationMs;
    outputTokens += metric.throughputOutputTokens;
  }
  return durationMs > 0 ? outputTokens / (durationMs / 1000) : undefined;
}
