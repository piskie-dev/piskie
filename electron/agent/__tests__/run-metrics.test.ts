import { describe, expect, it } from 'vitest';

import type { AIRequestInfo } from '../../../shared/types/context.js';
import type { ContentBlock } from '../../../shared/types/index.js';
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

const visibleText: ContentBlock[] = [{ type: 'text', text: 'done' }];

describe('AgentActivityTracker', () => {
  it('aggregates successful AI requests using provider request facts', () => {
    const tracker = new AgentActivityTracker();

    tracker.aiStarted(1_000);
    expect(tracker.snapshot()).toMatchObject({
      activeStartedAt: 1_000,
      activeLlmStartedAt: 1_000,
    });

    tracker.aiCompleted(requestInfo('request-1', {
      latencyMs: 200,
      firstVisibleContentLatencyMs: 10,
      generationDurationMs: 100,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 90 },
    }), visibleText);
    tracker.aiStarted(1_500);
    tracker.aiCompleted(requestInfo('request-2', {
      latencyMs: 300,
      firstVisibleContentLatencyMs: 30,
      generationDurationMs: 900,
      usage: { inputTokens: 900, outputTokens: 80, cacheReadTokens: 10 },
    }), [{ type: 'thinking', thinking: 'inspect' }]);

    expect(tracker.snapshot()).toMatchObject({
      activeStartedAt: 1_000,
      runMetrics: {
        rounds: 2,
        llmDurationMs: 500,
        firstVisibleContentLatencyTotalMs: 40,
        firstVisibleContentSamples: 2,
        generationDurationMs: 1_000,
        generationOutputTokens: 100,
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 100,
        coverage: {
          firstVisibleContent: 'complete',
          throughput: 'complete',
          inputTokens: 'complete',
          outputTokens: 'complete',
          cacheReadTokens: 'complete',
        },
      },
    });
    expect(tracker.snapshot().activeLlmStartedAt).toBeUndefined();
  });

  it('does not settle a failed or cancelled AI request', () => {
    const tracker = new AgentActivityTracker();

    tracker.aiStarted(10);
    tracker.aiStopped();

    expect(tracker.snapshot()).toMatchObject({
      activeStartedAt: 10,
      runMetrics: { rounds: 0, llmDurationMs: 0 },
    });
    expect(tracker.snapshot().activeLlmStartedAt).toBeUndefined();
  });

  it('keeps unknown request measurements distinct from measured zero', () => {
    const tracker = new AgentActivityTracker();

    tracker.aiCompleted(requestInfo('unknown'), visibleText);
    tracker.aiCompleted(requestInfo('zero', {
      firstVisibleContentLatencyMs: 0,
      generationDurationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    }), visibleText);

    expect(tracker.snapshot().runMetrics.coverage).toMatchObject({
      firstVisibleContent: 'partial',
      throughput: 'partial',
      inputTokens: 'partial',
      outputTokens: 'partial',
      cacheReadTokens: 'partial',
    });

    const measuredZero = new AgentActivityTracker();
    measuredZero.aiCompleted(requestInfo('zero-only', {
      firstVisibleContentLatencyMs: 0,
      generationDurationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    }), visibleText);
    expect(measuredZero.snapshot().runMetrics.coverage).toMatchObject({
      firstVisibleContent: 'complete',
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
    }), visibleText);
    tracker.aiCompleted(requestInfo('cached', {
      usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 200 },
    }), visibleText);

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

  it('does not make visible-content measurements applicable to a tool-only response', () => {
    const tracker = new AgentActivityTracker();
    tracker.aiCompleted(requestInfo('tool-only', {
      firstVisibleContentLatencyMs: 10,
      generationDurationMs: 20,
      usage: { inputTokens: 8, outputTokens: 3 },
    }), [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }]);

    expect(tracker.snapshot().runMetrics.coverage).toMatchObject({
      firstVisibleContent: 'none',
      throughput: 'none',
      inputTokens: 'complete',
      outputTokens: 'complete',
    });
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
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    tracker.aiCompleted(info, visibleText);
    tracker.aiCompleted(info, visibleText);

    expect(tracker.snapshot().runMetrics).toMatchObject({
      rounds: 1,
      llmDurationMs: 250,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('clears only activity clocks when a runtime becomes inert', () => {
    const tracker = new AgentActivityTracker();
    tracker.aiStarted(100);
    tracker.aiCompleted(requestInfo('request-1'), visibleText);
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
});
