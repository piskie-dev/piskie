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
    firstTokenLatencyTotalMs: 48_000,
    firstTokenSamples: 4,
    throughputDurationMs: 58_000,
    throughputOutputTokens: 950,
    inputTokens: 1_000,
    outputTokens: 950,
    cacheReadTokens: 100,
    coverage: {
      toolTiming: coverage,
      firstToken: coverage,
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
      firstToken: '12s',
      throughput: '16.4 tok/s',
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
      firstToken: '—',
      throughput: '—',
      cache: '—',
      input: '—',
      output: '—',
    });
  });

  it('shows zero output throughput when paired duration is positive', () => {
    const labels = agentMetricLabels(metrics('complete', {
      firstTokenLatencyTotalMs: 0,
      throughputDurationMs: 1_000,
      throughputOutputTokens: 0,
      outputTokens: 0,
    }), 1_000, undefined, undefined, labelOptions);

    expect(labels.throughput).toBe('0.0 tok/s');
  });

  it('shows absent throughput coverage as unknown', () => {
    const labels = agentMetricLabels(metrics('none', {
      firstTokenLatencyTotalMs: 0,
      firstTokenSamples: 0,
      throughputDurationMs: 0,
      throughputOutputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    }), 1_000, undefined, undefined, labelOptions);

    expect(labels.throughput).toBe('—');
  });

  it('keeps measured zero distinct from unknown', () => {
    expect(agentMetricLabels(metrics('complete', {
      rounds: 1,
      firstTokenLatencyTotalMs: 0,
      firstTokenSamples: 1,
      throughputDurationMs: 0,
      throughputOutputTokens: 0,
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
    }), 1_000, undefined, undefined, labelOptions)).toMatchObject({
      firstToken: '0s',
      throughput: '—',
      cache: '0%',
      output: '0',
    });
  });
});
