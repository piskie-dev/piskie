import { describe, expect, it } from 'vitest';
import type { AgentLiveContentDelta } from '@shared/electron-contracts/agents';
import {
  applyLiveDelta,
  commitLiveGeneration,
  emptyLiveGeneration,
  finishLiveGeneration,
  projectLiveNodes,
} from '../live-generation';

function delta(
  sequence: number,
  kind: 'think' | 'text',
  text: string,
  overrides: Partial<AgentLiveContentDelta> = {},
): AgentLiveContentDelta {
  return {
    agentId: 'agent-1',
    requestId: 'request-1',
    runId: 'run-1',
    sequence,
    kind,
    delta: text,
    ...overrides,
    attempt: overrides.attempt ?? 1,
  };
}

describe('LiveGeneration', () => {
  it('merges adjacent parts and preserves kind transitions', () => {
    let live = applyLiveDelta(emptyLiveGeneration(), delta(1, 'think', 'A'), 'request-1');
    live = applyLiveDelta(live, delta(2, 'think', 'B'), 'request-1');
    live = applyLiveDelta(live, delta(3, 'text', 'C'), 'request-1');

    expect(live).toMatchObject({
      phase: 'streaming',
      lastSequence: 3,
      parts: [
        { kind: 'think', markdown: 'AB' },
        { kind: 'text', markdown: 'C' },
      ],
    });
    expect(projectLiveNodes('agent-1', live).map((node) => node.kind))
      .toEqual(['think', 'assistant']);
  });

  it('keeps a successful generation until its canonical append commits', () => {
    const streaming = applyLiveDelta(
      emptyLiveGeneration(),
      delta(1, 'text', 'answer'),
      'request-1',
    );
    const awaiting = finishLiveGeneration(streaming, 'request-1', 'success');
    expect(awaiting.phase).toBe('awaiting-commit');
    expect(projectLiveNodes('agent-1', awaiting)).toHaveLength(1);

    const committed = commitLiveGeneration(awaiting, 'request-1');
    expect(committed.phase).toBe('closed');
    expect(projectLiveNodes('agent-1', committed)).toEqual([]);
  });

  it('replaces the visible draft on the first delta from each newer attempt', () => {
    let live = applyLiveDelta(emptyLiveGeneration(), delta(1, 'think', 'old thought'), 'request-1');
    live = applyLiveDelta(live, delta(2, 'text', 'old answer'), 'request-1');
    expect(live).toMatchObject({
      phase: 'streaming',
      attempt: 1,
      parts: [
        { kind: 'think', markdown: 'old thought' },
        { kind: 'text', markdown: 'old answer' },
      ],
    });

    live = applyLiveDelta(
      live,
      delta(3, 'think', 'new thought', { attempt: 2 }),
      'request-1',
    );
    expect(live).toMatchObject({
      phase: 'streaming',
      attempt: 2,
      lastSequence: 3,
      parts: [{ kind: 'think', markdown: 'new thought' }],
    });

    live = applyLiveDelta(live, delta(4, 'text', 'new answer', { attempt: 2 }), 'request-1');
    live = applyLiveDelta(live, delta(5, 'text', 'final answer', { attempt: 3 }), 'request-1');
    expect(live).toMatchObject({
      phase: 'streaming',
      attempt: 3,
      lastSequence: 5,
      parts: [{ kind: 'text', markdown: 'final answer' }],
    });
  });

  it('keeps sequence validation when a newer attempt starts', () => {
    const started = applyLiveDelta(
      emptyLiveGeneration(),
      delta(1, 'text', 'old answer'),
      'request-1',
    );
    const gap = applyLiveDelta(
      started,
      delta(3, 'text', 'new answer', { attempt: 2 }),
      'request-1',
    );

    expect(gap).toMatchObject({ phase: 'suppressed', reason: 'sequence-gap' });
  });

  it('applies the memory limit to the replacement attempt instead of the old draft', () => {
    const fullDraft = 'A'.repeat(2 * 1024 * 1024);
    const started = applyLiveDelta(
      emptyLiveGeneration(),
      delta(1, 'text', fullDraft),
      'request-1',
    );
    const replaced = applyLiveDelta(
      started,
      delta(2, 'text', 'replacement', { attempt: 2 }),
      'request-1',
    );

    expect(replaced).toMatchObject({
      phase: 'streaming',
      attempt: 2,
      parts: [{ kind: 'text', markdown: 'replacement' }],
    });
  });

  it('suppresses gaps and run conflicts without accepting later deltas', () => {
    const started = applyLiveDelta(
      emptyLiveGeneration(),
      delta(1, 'text', 'A'),
      'request-1',
    );
    const gap = applyLiveDelta(started, delta(3, 'text', 'C'), 'request-1');
    expect(gap).toMatchObject({ phase: 'suppressed', reason: 'sequence-gap' });
    expect(applyLiveDelta(gap, delta(2, 'text', 'B'), 'request-1')).toBe(gap);

    const conflict = applyLiveDelta(
      started,
      delta(2, 'text', 'B', { runId: 'run-2' }),
      'request-1',
    );
    expect(conflict).toMatchObject({ phase: 'suppressed', reason: 'run-conflict' });
  });

  it('rejects a late delta after failure closes the generation', () => {
    const streaming = applyLiveDelta(
      emptyLiveGeneration(),
      delta(1, 'text', 'partial'),
      'request-1',
    );
    const closed = finishLiveGeneration(streaming, 'request-1', 'failed');
    expect(applyLiveDelta(closed, delta(2, 'text', 'late'), 'request-1')).toBe(closed);
  });

  it('requires sequence one and the active request', () => {
    expect(applyLiveDelta(
      emptyLiveGeneration(),
      delta(1, 'text', 'ignored'),
      'another-request',
    )).toEqual({ phase: 'none' });
    expect(applyLiveDelta(
      emptyLiveGeneration(),
      delta(2, 'text', 'suffix'),
      'request-1',
    )).toMatchObject({ phase: 'suppressed', reason: 'missing-prefix' });
  });
});
