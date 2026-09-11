import { describe, expect, it, vi } from 'vitest';

import type {
  AgentControlSnapshot,
  AgentRunClient,
  AgentRunSnapshot,
} from '@shared/electron-contracts/agent-runs';
import { createAgentRunRepository } from '../agent-run-repository';

function run(agentId: string): AgentRunSnapshot {
  return {
    agentId,
    agentSpec: 'director',
    modeId: 'normal',
    approvalMode: 'confirm',
    runConfig: { name: agentId },
    createdAt: '2026-08-19T00:00:00.000Z',
    lastActiveAt: '2026-08-19T00:00:00.000Z',
    currentModel: 'provider/model',
    childAgents: [],
    messages: { latestMessage: null, latestAssistantIndex: -1, readThroughIndex: -1 },
  } as unknown as AgentRunSnapshot;
}

function control(agentId: string): AgentControlSnapshot {
  return {
    agentId,
    phase: 'waiting',
    children: [],
    runConfig: { name: agentId },
  } as unknown as AgentControlSnapshot;
}

function client(overrides: Partial<AgentRunClient> = {}): AgentRunClient {
  return {
    list: vi.fn(async () => []),
    state: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
    readPlan: vi.fn(),
    listCompactions: vi.fn(),
    originalCompactionMessages: vi.fn(),
    ...overrides,
  } as AgentRunClient;
}

describe('AgentRunRepository', () => {
  it('releases target resources only after a successful permanent deletion', async () => {
    const released = vi.fn();
    const remove = vi.fn().mockRejectedValueOnce(new Error('not deleted')).mockResolvedValueOnce(undefined);
    const repository = createAgentRunRepository(client({ delete: remove }), released);
    await expect(repository.delete('example-session')).rejects.toThrow('not deleted');
    expect(released).not.toHaveBeenCalled();
    await repository.delete('example-session');
    expect(released).toHaveBeenCalledExactlyOnceWith('example-session');
  });

  it('fences a late preview response from a previously selected run', async () => {
    let resolveFirst!: (value: AgentControlSnapshot | null) => void;
    let resolveSecond!: (value: AgentControlSnapshot | null) => void;
    const state = vi.fn()
      .mockReturnValueOnce(new Promise<AgentControlSnapshot | null>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockReturnValueOnce(new Promise<AgentControlSnapshot | null>((resolve) => {
        resolveSecond = resolve;
      }));
    const repository = createAgentRunRepository(client({ state }));

    const first = repository.loadPreview('first');
    const second = repository.loadPreview('second');
    resolveSecond(control('second'));
    await second;
    resolveFirst(control('first'));
    await first;

    expect(repository.previewState.getState()).toMatchObject({
      phase: 'ready',
      agentId: 'second',
      state: { agentId: 'second' },
    });
  });

  it('deletes through Main, clears the matching preview, and reloads the canonical list', async () => {
    const remove = vi.fn(async () => undefined);
    const list = vi.fn(async () => [run('remaining')]);
    const repository = createAgentRunRepository(client({
      delete: remove,
      list,
      state: vi.fn(async () => control('deleted')),
    }));
    await repository.loadPreview('deleted');
    await repository.delete('deleted');

    expect(remove).toHaveBeenCalledWith('deleted');
    expect(repository.previewState.getState()).toEqual({
      phase: 'idle',
      agentId: null,
      state: null,
      error: null,
    });
    expect(repository.listState.getState().runs).toEqual([run('remaining')]);
  });

  it('preserves newer appended messages across an older read acknowledgement and list response', async () => {
    const base = run('sample-main');
    base.messages = { latestMessage: { index: 2, timestamp: 2000 }, latestAssistantIndex: 2, readThroughIndex: -1 };
    let finishList!: (runs: AgentRunSnapshot[]) => void;
    let finishRead!: (messages: AgentRunSnapshot['messages']) => void;
    const list = vi.fn().mockResolvedValueOnce([base]).mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }));
    const repository = createAgentRunRepository(client({ list, markRead: () => new Promise((resolve) => { finishRead = resolve; }) }));
    await repository.refresh();
    const listing = repository.refresh();
    const reading = repository.markRead('sample-main', 2);
    repository.applyConversation({
      agentId: 'sample-main', index: 3,
      entry: { t: 'msg', role: 'assistant', id: 'sample-reply', ts: 3000, content: 'Example reply' },
      messages: { latestMessage: { index: 3, timestamp: 3000 }, latestAssistantIndex: 3, readThroughIndex: -1 },
    });
    finishRead({ ...base.messages, readThroughIndex: 2 });
    await reading;
    finishList([base]);
    await listing;
    expect(repository.listState.getState().runs[0]!.messages).toEqual({
      latestMessage: { index: 3, timestamp: 3000 }, latestAssistantIndex: 3, readThroughIndex: 2,
    });
  });

  it('keeps list and preview request state independent', async () => {
    const repository = createAgentRunRepository(client({
      list: vi.fn(async () => {
        throw new Error('list failed');
      }),
      state: vi.fn(async () => control('history')),
    }));

    await Promise.all([repository.refresh(), repository.loadPreview('history')]);

    expect(repository.listState.getState()).toMatchObject({
      phase: 'failed',
      error: 'list failed',
    });
    expect(repository.previewState.getState()).toMatchObject({
      phase: 'ready',
      agentId: 'history',
    });
  });
});
