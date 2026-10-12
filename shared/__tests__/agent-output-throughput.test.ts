import { describe, expect, it } from 'vitest';

import { averageOutputThroughput } from '../agent-output-throughput.js';
import type { AgentRunMetrics, MetricCoverage } from '../types/agent-control.js';

function metrics(
  durationMs: number,
  outputTokens: number,
  coverage: MetricCoverage = 'complete',
  rounds = 1,
): AgentRunMetrics {
  return {
    version: 1,
    rounds,
    steps: 0,
    llmDurationMs: durationMs + 1_000,
    toolDurationMs: 0,
    firstTokenLatencyTotalMs: 0,
    firstTokenSamples: 0,
    throughputDurationMs: durationMs,
    throughputOutputTokens: outputTokens,
    inputTokens: 0,
    outputTokens,
    cacheReadTokens: 0,
    coverage: {
      toolTiming: 'none',
      firstToken: 'none',
      throughput: coverage,
      inputTokens: 'none',
      outputTokens: coverage,
      cacheReadTokens: 'none',
    },
  };
}

describe('averageOutputThroughput', () => {
  it('uses paired totals for one Agent across multiple rounds', () => {
    expect(averageOutputThroughput([metrics(1_000, 100, 'complete', 2)])).toBe(100);
  });

  it('weights multiple Agents by final-attempt duration', () => {
    expect(averageOutputThroughput([metrics(100, 20), metrics(900, 80)])).toBe(100);
  });

  it('ignores a root with no settled requests when its child has complete samples', () => {
    expect(averageOutputThroughput([metrics(0, 0, 'none', 0), metrics(85, 3)]))
      .toBeCloseTo(3 / 0.085);
  });

  it.each([
    { coverage: 'partial' as const, durationMs: 100, outputTokens: 10, rounds: 2 },
    { coverage: 'none' as const, durationMs: 0, outputTokens: 0, rounds: 1 },
  ])('keeps $coverage coverage unknown across Agents', ({ coverage, durationMs, outputTokens, rounds }) => {
    expect(averageOutputThroughput([
      metrics(200, 20), metrics(durationMs, outputTokens, coverage, rounds),
    ])).toBeUndefined();
  });

  it('keeps an empty scope and Agents with no settled samples unknown', () => {
    expect(averageOutputThroughput([])).toBeUndefined();
    expect(averageOutputThroughput([metrics(0, 0, 'none', 0)])).toBeUndefined();
  });

  it('keeps zero total duration unknown even with known output', () => {
    expect(averageOutputThroughput([metrics(0, 3)])).toBeUndefined();
    expect(averageOutputThroughput([metrics(0, 0)])).toBeUndefined();
  });

  it('preserves measured zero output over positive duration', () => {
    expect(averageOutputThroughput([metrics(200, 0)])).toBe(0);
  });

  it('includes measured zero-duration samples when aggregate duration is positive', () => {
    expect(averageOutputThroughput([metrics(0, 2), metrics(100, 8)])).toBe(100);
  });
});
