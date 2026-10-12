import { describe, expect, it } from 'vitest';

import { averageOutputThroughput } from '../../../shared/agent-output-throughput.js';
import type { AIRequestInfo } from '../../../shared/types/context.js';
import { AgentActivityTracker } from '../run-metrics.js';

function requestInfo(
  requestId: string,
  overrides: Partial<AIRequestInfo> = {},
): AIRequestInfo {
  return {
    version: 1,
    requestId,
    runId: `run-${requestId}`,
    model: 'provider::model',
    stopReason: 'end_turn',
    latencyMs: 100,
    usage: {},
    ...overrides,
  };
}

describe('AgentActivityTracker', () => {
  it('aggregates successful AI requests using provider request facts', () => {
    const tracker = new AgentActivityTracker();

    tracker.aiStarted(1_000, 'request-1');
    expect(tracker.snapshot()).toMatchObject({
      activeStartedAt: 1_000,
      activeLlmStartedAt: 1_000,
    });

    tracker.aiCompleted(requestInfo('request-1', {
      latencyMs: 200,
      firstTokenLatencyMs: 10,
      attemptDurationMs: 100,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 90 },
    }));
    tracker.aiStarted(1_500, 'request-2');
    tracker.aiCompleted(requestInfo('request-2', {
      latencyMs: 1_300,
      firstTokenLatencyMs: 30,
      attemptDurationMs: 900,
      usage: { inputTokens: 900, outputTokens: 80, cacheReadTokens: 10 },
    }));

    expect(tracker.snapshot()).toMatchObject({
      activeStartedAt: 1_000,
      runMetrics: {
        rounds: 2,
        llmDurationMs: 1_500,
        firstTokenLatencyTotalMs: 40,
        firstTokenSamples: 2,
        throughputDurationMs: 1_000,
        throughputOutputTokens: 100,
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 100,
        coverage: {
          firstToken: 'complete',
          throughput: 'complete',
          inputTokens: 'complete',
          outputTokens: 'complete',
          cacheReadTokens: 'complete',
        },
      },
    });
    expect(tracker.snapshot().activeLlmStartedAt).toBeUndefined();
    expect(averageOutputThroughput([tracker.snapshot().runMetrics])).toBe(100);
  });

  it('does not settle a failed or cancelled AI request', () => {
    const tracker = new AgentActivityTracker();

    tracker.aiStarted(10, 'failed-request');
    tracker.aiStopped();

    expect(tracker.snapshot()).toMatchObject({
      activeStartedAt: 10,
      runMetrics: { rounds: 0, llmDurationMs: 0 },
    });
    expect(tracker.snapshot().activeLlmStartedAt).toBeUndefined();
  });

  it('keeps unknown request measurements distinct from measured zero', () => {
    const tracker = new AgentActivityTracker();

    tracker.aiCompleted(requestInfo('unknown'));
    tracker.aiCompleted(requestInfo('zero', {
      firstTokenLatencyMs: 0,
      attemptDurationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    }));

    expect(tracker.snapshot().runMetrics.coverage).toMatchObject({
      firstToken: 'partial',
      throughput: 'partial',
      inputTokens: 'partial',
      outputTokens: 'partial',
      cacheReadTokens: 'partial',
    });

    const measuredZero = new AgentActivityTracker();
    measuredZero.aiCompleted(requestInfo('zero-only', {
      firstTokenLatencyMs: 0,
      attemptDurationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    }));
    expect(measuredZero.snapshot().runMetrics.coverage).toMatchObject({
      firstToken: 'complete',
      throughput: 'complete',
      inputTokens: 'complete',
      outputTokens: 'complete',
      cacheReadTokens: 'complete',
    });
  });

  it('treats an omitted cache detail as zero in the agent session aggregate', () => {
    const tracker = new AgentActivityTracker();

    tracker.aiCompleted(requestInfo('uncached', {
      usage: { inputTokens: 100, outputTokens: 10 },
    }));
    tracker.aiCompleted(requestInfo('cached', {
      usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 200 },
    }));

    expect(tracker.snapshot().runMetrics).toMatchObject({
      inputTokens: 400,
      outputTokens: 30,
      cacheReadTokens: 200,
      coverage: {
        inputTokens: 'complete',
        outputTokens: 'complete',
        cacheReadTokens: 'complete',
      },
    });
  });

  it('includes tool-only output throughput and excludes actual tool execution time', () => {
    const tracker = new AgentActivityTracker();
    tracker.aiCompleted(requestInfo('tool-only', {
      firstTokenLatencyMs: 10,
      attemptDurationMs: 30,
      usage: { inputTokens: 8, outputTokens: 3 },
      stopReason: 'tool_use',
    }));

    tracker.toolStarted('tool-call', 1_000);
    tracker.toolFinished('tool-call', { startedAt: 1_000, finishedAt: 1_600 });
    tracker.toolSettled('tool-call');

    expect(tracker.snapshot().runMetrics).toMatchObject({
      llmDurationMs: 100,
      toolDurationMs: 600,
      firstTokenLatencyTotalMs: 10,
      firstTokenSamples: 1,
      throughputDurationMs: 30,
      throughputOutputTokens: 3,
      coverage: {
        firstToken: 'complete',
        throughput: 'complete',
        inputTokens: 'complete',
        outputTokens: 'complete',
      },
    });
    expect(averageOutputThroughput([tracker.snapshot().runMetrics])).toBe(100);
  });

  it('includes paired throughput without an observed first token', () => {
    const tracker = new AgentActivityTracker();
    tracker.aiCompleted(requestInfo('usage-only', {
      latencyMs: 300,
      attemptDurationMs: 200,
      usage: { outputTokens: 12 },
    }));

    expect(tracker.snapshot().runMetrics).toMatchObject({
      firstTokenSamples: 0,
      throughputDurationMs: 200,
      throughputOutputTokens: 12,
      coverage: { firstToken: 'none', throughput: 'complete' },
    });
    expect(averageOutputThroughput([tracker.snapshot().runMetrics])).toBe(60);
  });

  it('accumulates duration and output only when both facts are known', () => {
    const tracker = new AgentActivityTracker();
    tracker.aiCompleted(requestInfo('missing-duration', { usage: { outputTokens: 900 } }));
    tracker.aiCompleted(requestInfo('missing-output', { attemptDurationMs: 100 }));
    tracker.aiCompleted(requestInfo('paired', {
      latencyMs: 300,
      attemptDurationMs: 200,
      usage: { outputTokens: 20 },
    }));

    expect(tracker.snapshot().runMetrics).toMatchObject({
      rounds: 3,
      throughputDurationMs: 200,
      throughputOutputTokens: 20,
      outputTokens: 920,
      coverage: { throughput: 'partial' },
    });
    expect(averageOutputThroughput([tracker.snapshot().runMetrics])).toBeUndefined();
  });

  it('unions parallel tool execution intervals and counts each settlement once', () => {
    const tracker = new AgentActivityTracker();

    tracker.toolStarted('call-a', 100);
    tracker.toolStarted('call-b', 102);
    expect(tracker.snapshot()).toMatchObject({
      activeStartedAt: 100,
      activeToolPhaseStartedAt: 100,
    });

    tracker.toolFinished('call-a', { startedAt: 100, finishedAt: 110 });
    expect(tracker.snapshot().runMetrics.toolDurationMs).toBe(0);
    expect(tracker.snapshot().activeToolPhaseStartedAt).toBe(100);

    tracker.toolFinished('call-b', { startedAt: 102, finishedAt: 114 });
    tracker.toolSettled('call-a');
    tracker.toolSettled('call-a');
    tracker.toolSettled('call-b');

    expect(tracker.snapshot()).toMatchObject({
      runMetrics: {
        steps: 2,
        toolDurationMs: 14,
        coverage: { toolTiming: 'complete' },
      },
    });
    expect(tracker.snapshot().activeToolPhaseStartedAt).toBeUndefined();
  });

  it('deduplicates a repeated request settlement', () => {
    const tracker = new AgentActivityTracker();
    const info = requestInfo('request-1', {
      latencyMs: 250,
      attemptDurationMs: 100,
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    tracker.aiCompleted(info);
    tracker.aiCompleted(info);

    expect(tracker.snapshot().runMetrics).toMatchObject({
      rounds: 1,
      llmDurationMs: 250,
      throughputDurationMs: 100,
      throughputOutputTokens: 5,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('clears only activity clocks when a runtime becomes inert', () => {
    const tracker = new AgentActivityTracker();
    tracker.aiStarted(100, 'request-1');
    tracker.aiCompleted(requestInfo('request-1'));
    tracker.toolStarted('call-1', 200);
    tracker.toolFinished('call-1', { startedAt: 200, finishedAt: 210 });
    tracker.toolSettled('call-1');

    tracker.activityStopped();

    expect(tracker.snapshot()).toEqual(expect.objectContaining({
      runMetrics: expect.objectContaining({ rounds: 1, steps: 1, toolDurationMs: 10 }),
    }));
    expect(tracker.snapshot().activeStartedAt).toBeUndefined();
    expect(tracker.snapshot().activeLlmStartedAt).toBeUndefined();
    expect(tracker.snapshot().activeToolPhaseStartedAt).toBeUndefined();
  });

  it('estimates accumulated content independently of chunk size, including Unicode split across chunks', () => {
    const whole = new AgentActivityTracker();
    const fragmented = new AgentActivityTracker();
    const base = { runId: 'run-1', attempt: 1 };
    for (const tracker of [whole, fragmented]) {
      tracker.aiStarted(100, 'request-1');
      tracker.aiProgress('request-1', { ...base, kind: 'attempt-started' });
      expect(tracker.snapshot().activeOutputTokens).toBeUndefined();
    }
    whole.aiProgress('request-1', { ...base, kind: 'delta', sequence: 2, delta: 'abcd示例😀' });
    const pieces = ['a', 'b', 'c', 'd', '示', '例', '\ud83d', '\ude00'];
    const changed = pieces.map((delta, index) => fragmented.aiProgress('request-1', {
      ...base, kind: 'delta', sequence: index + 2, delta,
    }));

    expect(whole.snapshot().activeOutputTokens).toEqual({ count: 4, estimated: true });
    expect(fragmented.snapshot().activeOutputTokens).toEqual(whole.snapshot().activeOutputTokens);
    expect(changed).toEqual([true, false, false, false, true, true, true, false]);
  });

  it('estimates after an initial usage checkpoint and corrects rather than adding provider output', () => {
    const tracker = new AgentActivityTracker();
    const base = { runId: 'run-1', attempt: 1 };
    tracker.aiStarted(100, 'request-1');
    tracker.aiProgress('request-1', { ...base, kind: 'attempt-started' });
    tracker.aiProgress('request-1', { ...base, kind: 'usage', sequence: 2, outputTokens: 0 });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 0, estimated: false });
    tracker.aiProgress('request-1', { ...base, kind: 'delta', sequence: 3, delta: 'abcdefgh' });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 2, estimated: true });
    tracker.aiProgress('request-1', { ...base, kind: 'usage', sequence: 4, outputTokens: 7 });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 7, estimated: false });
    tracker.aiProgress('request-1', { ...base, kind: 'delta', sequence: 5, delta: 'abcd' });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 8, estimated: true });
    tracker.aiCompleted(requestInfo('request-1', { usage: { outputTokens: 5, reasoningTokens: 3 } }));
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 5, estimated: false });
    tracker.aiCompleted(requestInfo('request-1', { usage: { outputTokens: 5, reasoningTokens: 3 } }));
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 5, estimated: false });
  });

  it('keeps settled output across tools and model rounds without adding usage twice', () => {
    const tracker = new AgentActivityTracker();
    tracker.aiStarted(100, 'request-1');
    tracker.aiCompleted(requestInfo('request-1', { usage: { outputTokens: 12 } }));
    tracker.toolStarted('call-1', 200);
    tracker.toolFinished('call-1', { startedAt: 200, finishedAt: 300 });
    tracker.aiStarted(400, 'request-2');
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 12, estimated: false });
    expect(tracker.snapshot().activeStartedAt).toBe(100);
    const base = { runId: 'run-2', attempt: 1 };
    tracker.aiProgress('request-2', { ...base, kind: 'attempt-started' });
    tracker.aiProgress('request-2', { ...base, kind: 'delta', sequence: 2, delta: 'abcdef' });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 14, estimated: true });
    tracker.aiProgress('request-2', { ...base, kind: 'usage', sequence: 3, outputTokens: 3 });
    tracker.aiCompleted(requestInfo('request-2', { usage: { outputTokens: 3 } }));
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 15, estimated: false });
  });

  it('retains an estimate without usage, then clears output at activity end and starts fresh', () => {
    const tracker = new AgentActivityTracker();
    const base = { runId: 'run-1', attempt: 1 };
    tracker.aiStarted(100, 'request-1');
    tracker.aiProgress('request-1', { ...base, kind: 'attempt-started' });
    tracker.aiProgress('request-1', { ...base, kind: 'delta', sequence: 2, delta: 'abcdef' });
    tracker.aiCompleted(requestInfo('request-1'));
    tracker.aiStarted(200, 'request-2');
    tracker.aiCompleted(requestInfo('request-2', { usage: { outputTokens: 10 } }));
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 12, estimated: true });

    tracker.activityStopped();
    expect(tracker.snapshot().activeOutputTokens).toBeUndefined();
    expect(tracker.snapshot().runMetrics.rounds).toBe(2);
    tracker.aiStarted(300, 'request-3');
    expect(tracker.snapshot().activeStartedAt).toBe(300);
    expect(tracker.snapshot().activeOutputTokens).toBeUndefined();
    expect(tracker.aiProgress('request-1', { ...base, kind: 'usage', sequence: 3, outputTokens: 999 })).toBe(false);
    expect(tracker.snapshot().activeOutputTokens).toBeUndefined();
  });

  it('replaces retry and overflow contributions while rejecting old attempts, runs and duplicate deltas', () => {
    const tracker = new AgentActivityTracker();
    tracker.aiStarted(100, 'previous-request');
    tracker.aiCompleted(requestInfo('previous-request', { usage: { outputTokens: 5 } }));
    tracker.aiStarted(200, 'request-1');
    const first = { runId: 'run-1', attempt: 1 };
    tracker.aiProgress('request-1', { ...first, kind: 'attempt-started' });
    tracker.aiProgress('request-1', { ...first, kind: 'usage', sequence: 3, outputTokens: 40 });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 45, estimated: false });
    const retry = { runId: 'run-1', attempt: 2 };
    tracker.aiProgress('request-1', { ...retry, kind: 'attempt-started' });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 5, estimated: false });
    tracker.aiProgress('request-1', { ...retry, kind: 'delta', sequence: 5, delta: 'abcdefgh' });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 7, estimated: true });
    expect(tracker.aiProgress('request-1', { ...first, kind: 'delta', sequence: 100, delta: 'stale' })).toBe(false);
    expect(tracker.aiProgress('request-1', { ...first, kind: 'attempt-started' })).toBe(false);
    expect(tracker.aiProgress('request-1', { ...retry, kind: 'delta', sequence: 5, delta: 'duplicate' })).toBe(false);
    const resend = { runId: 'run-2', attempt: 1 };
    tracker.aiProgress('request-1', { ...resend, kind: 'attempt-started' });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 5, estimated: false });
    expect(tracker.aiProgress('request-1', { ...retry, kind: 'usage', sequence: 101, outputTokens: 999 })).toBe(false);
    tracker.aiProgress('request-1', { ...resend, kind: 'delta', sequence: 2, delta: 'abcd' });
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 6, estimated: true });
    expect(tracker.snapshot().activeStartedAt).toBe(100);
  });

  it('rejects progress after a request stops and after the activity is cancelled', () => {
    const tracker = new AgentActivityTracker();
    const base = { runId: 'run-1', attempt: 1 };
    tracker.aiStarted(100, 'request-1');
    tracker.aiProgress('request-1', { ...base, kind: 'attempt-started' });
    tracker.aiProgress('request-1', { ...base, kind: 'delta', sequence: 2, delta: 'abcd' });
    tracker.aiStopped();
    expect(tracker.aiProgress('request-1', { ...base, kind: 'usage', sequence: 3, outputTokens: 999 })).toBe(false);
    expect(tracker.snapshot().activeOutputTokens).toEqual({ count: 1, estimated: true });
    tracker.activityStopped();
    expect(tracker.aiProgress('request-1', { ...base, kind: 'delta', sequence: 4, delta: 'late' })).toBe(false);
    expect(tracker.snapshot().activeOutputTokens).toBeUndefined();
  });
});
