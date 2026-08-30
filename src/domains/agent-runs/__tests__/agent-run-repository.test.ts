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
