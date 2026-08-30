import { describe, expect, it, vi } from 'vitest';
import type { AgentClient } from '@shared/electron-contracts/agents';
import type { ContextSnapshot } from '@shared/types/token';
import { createContextInspectorResource } from '../context-inspector-resource';

function snapshot(systemPrompt: string): ContextSnapshot {
  return {
    systemPrompt,
    tools: [],
    messages: [],
    requestTokenCheckpoints: [],
    usage: { limit: 200_000 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('contextInspectorResource', () => {
  it('discards an old agent response after opening another agent', async () => {
    const first = deferred<ContextSnapshot>();
    const second = deferred<ContextSnapshot>();
    const context = vi.fn((agentId: string) => (
      agentId === 'a' ? first.promise : second.promise
    ));
    const resource = createContextInspectorResource({ context } as unknown as AgentClient);

    const openingA = resource.open('a');
    const openingB = resource.open('b');
    first.resolve(snapshot('old'));
    second.resolve(snapshot('current'));
    await Promise.all([openingA, openingB]);

    expect(resource.state.getState()).toMatchObject({
      phase: 'ready',
      agentId: 'b',
      snapshot: { systemPrompt: 'current' },
    });
  });

  it('keeps current data visible while refresh is in flight', async () => {
    const refreshed = deferred<ContextSnapshot>();
    const context = vi.fn()
      .mockResolvedValueOnce(snapshot('first'))
      .mockReturnValueOnce(refreshed.promise);
    const resource = createContextInspectorResource({ context } as unknown as AgentClient);
    await resource.open('a');

    const refresh = resource.refresh();
    expect(resource.state.getState()).toMatchObject({
      phase: 'refreshing',
      snapshot: { systemPrompt: 'first' },
    });
    refreshed.resolve(snapshot('second'));
    await refresh;
    expect(resource.state.getState()).toMatchObject({
      phase: 'ready',
      snapshot: { systemPrompt: 'second' },
    });
  });

  it('releases the snapshot and ignores an in-flight response on close', async () => {
    const pending = deferred<ContextSnapshot>();
    const resource = createContextInspectorResource({
      context: vi.fn(() => pending.promise),
    } as unknown as AgentClient);
    const opening = resource.open('a');
    resource.close();
    pending.resolve(snapshot('late'));
    await opening;

    expect(resource.state.getState()).toMatchObject({
      phase: 'closed',
      agentId: null,
      snapshot: null,
    });
  });
});
