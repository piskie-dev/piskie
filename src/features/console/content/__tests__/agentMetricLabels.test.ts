import { describe, expect, it } from 'vitest';

import type { AgentRunMetrics, MetricCoverage } from '../../../../../shared/types/agent-control';
import { agentMetricLabels } from '../agentMetricLabels';

function metrics(
  coverage: MetricCoverage = 'complete',
  overrides: Partial<AgentRunMetrics> = {},
): AgentRunMetrics {
  return {
    version: 1,
    rounds: 4,
    steps: 47,
    llmDurationMs: 575_000,
    toolDurationMs: 154_000,
    firstVisibleContentLatencyTotalMs: 48_000,
    firstVisibleContentSamples: 4,
    generationDurationMs: 10_000,
    generationOutputTokens: 950,
    inputTokens: 1_000,
    outputTokens: 950,
    cacheReadTokens: 100,
    coverage: {
      toolTiming: coverage,
      firstVisibleContent: coverage,
      throughput: coverage,
      inputTokens: coverage,
      outputTokens: coverage,
      cacheReadTokens: coverage,
    },
    ...overrides,
  };
}

const labelOptions = {
  locale: 'zh-CN',
  rounds: (count: number) => `${count}轮`,
  steps: (count: number) => `${count}步`,
};

describe('agentMetricLabels', () => {
  it('formats every documented metric from weighted projector totals', () => {
    expect(agentMetricLabels(metrics(), 1_000_000, undefined, undefined, labelOptions)).toEqual({
      rounds: '4轮',
      steps: '47步',
      llm: '9m35s',
      tools: '2m34s',
      firstVisible: '12s',
      throughput: '95 tok/s',
      cache: '10%',
      input: '1.0k',
      output: '950',
    });
  });

  it('shows unknown coverage as unknown while preserving live duration overlays', () => {
    const labels = agentMetricLabels(
      metrics('partial', { rounds: 2, steps: 0, llmDurationMs: 1_000, toolDurationMs: 0 }),
      10_000,
      7_000,
      8_000,
      labelOptions,
    );

    expect(labels).toMatchObject({
      rounds: '2轮',
      steps: '0步',
      llm: '4s',
      tools: '2s',
      firstVisible: '—',
      throughput: '—',
      cache: '—',
      input: '—',
      output: '—',
    });
  });

  it('keeps measured zero distinct from unknown', () => {
    expect(agentMetricLabels(metrics('complete', {
      firstVisibleContentLatencyTotalMs: 0,
      firstVisibleContentSamples: 1,
      generationDurationMs: 0,
      generationOutputTokens: 0,
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
    }), 1_000, undefined, undefined, labelOptions)).toMatchObject({
      firstVisible: '0s',
      throughput: '—',
      cache: '0%',
      output: '0',
    });
  });
});
