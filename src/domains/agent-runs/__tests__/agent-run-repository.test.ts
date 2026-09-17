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

const modelA = { currentModel: 'sample::model-a', reasoningOverride: { kind: 'effort', effort: 'low' } } as const;
const modelB = { currentModel: 'sample::model-b', reasoningOverride: { kind: 'effort', effort: 'high' } } as const;
const modelC = { currentModel: 'sample::model-c', reasoningOverride: { kind: 'budget', tokens: 4096 } } as const;

function client(overrides: Partial<AgentRunClient> = {}): AgentRunClient {
  return {
    list: vi.fn(async () => []),
    state: vi.fn(async () => null),
    rename: vi.fn(async (agentId, name) => ({
      ...run(agentId),
      runConfig: { ...run(agentId).runConfig, name },
    })),
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

  it('refreshes a cold model and its different reasoning default together while keeping the preview ready', async () => {
    let finishRead!: (snapshot: AgentControlSnapshot) => void;
    const state = vi.fn().mockResolvedValueOnce({ ...control('sample-main'), ...modelA })
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
      .mockImplementation(async (agentId) => ({ ...control(agentId), ...modelA }));
    const repository = createAgentRunRepository(client({
      list: vi.fn(async () => [run('sample-main'), run('sample-other')]), state,
    }));
    await repository.refresh();
    await repository.loadPreview('sample-main');
    const previous = repository.previewState.getState();
    const changed = vi.fn();
    const unsubscribe = repository.previewState.subscribe(changed);
    const refreshing = repository.applyModel('sample-main', modelB.currentModel);
    expect(repository.listState.getState().runs[0]?.currentModel).toBe(modelB.currentModel);
    expect(repository.previewState.getState()).toBe(previous);
    expect(changed).not.toHaveBeenCalled();

    finishRead({ ...control('sample-main'), ...modelB });
    await refreshing;
    expect(repository.previewState.getState()).toMatchObject({ phase: 'ready', state: modelB });
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();

    await repository.loadPreview('sample-other');
    await repository.applyModel('sample-main', modelC.currentModel);
    expect(repository.previewState.getState()).toMatchObject({ agentId: 'sample-other', state: modelA });
    repository.clearPreview('sample-other');
    await repository.applyModel('sample-main', modelB.currentModel);
    expect(repository.previewState.getState().phase).toBe('idle');
    expect(state).toHaveBeenCalledTimes(3);
  });

  it('preserves a confirmed model across older list, preview and rename responses, then accepts fresh reads', async () => {
    const original = run('sample-main');
    let finishList!: (runs: AgentRunSnapshot[]) => void;
    let finishPreview!: (state: AgentControlSnapshot) => void;
    let finishRename!: (run: AgentRunSnapshot) => void;
    const state = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishPreview = resolve; }))
      .mockResolvedValueOnce({ ...control('sample-main'), ...modelB })
      .mockResolvedValue({ ...control('sample-main'), ...modelC });
    const list = vi.fn().mockResolvedValueOnce([original])
      .mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }))
      .mockResolvedValue([{ ...original, currentModel: modelC.currentModel }]);
    const repository = createAgentRunRepository(client({
      list, state,
      rename: vi.fn(() => new Promise<AgentRunSnapshot>((resolve) => { finishRename = resolve; })),
    }));
    await repository.refresh();
    const listing = repository.refresh();
    const previewing = repository.loadPreview('sample-main');
    const renaming = repository.rename('sample-main', 'Revised sample');
    await repository.applyModel('sample-main', modelB.currentModel);
    finishRename({ ...original, runConfig: { ...original.runConfig, name: 'Revised sample' } });
    await renaming;
    expect(repository.listState.getState().runs[0]?.currentModel).toBe(modelB.currentModel);
    finishList([original]);
    finishPreview({ ...control('sample-main'), ...modelA });
    await Promise.all([listing, previewing]);
    expect(repository.previewState.getState()).toMatchObject({ phase: 'ready', state: modelB });
    expect(repository.listState.getState().runs[0]?.currentModel).toBe(modelB.currentModel);

    repository.clearPreview();
    await repository.loadPreview('sample-main');
    await repository.refresh();
    expect(repository.previewState.getState()).toMatchObject({ state: modelC });
    expect(repository.listState.getState().runs[0]?.currentModel).toBe(modelC.currentModel);
  });

  it.each(['success', 'failure'] as const)('ignores a previous model read %s after a newer selection is confirmed', async (outcome) => {
    let finishPrevious!: (snapshot: AgentControlSnapshot) => void;
    let failPrevious!: (error: Error) => void;
    const state = vi.fn().mockResolvedValueOnce({ ...control('sample-main'), ...modelA })
      .mockImplementationOnce(() => new Promise((resolve, reject) => { finishPrevious = resolve; failPrevious = reject; }))
      .mockResolvedValueOnce({ ...control('sample-main'), ...modelC });
    const repository = createAgentRunRepository(client({ state }));
    await repository.loadPreview('sample-main');

    const previous = repository.applyModel('sample-main', modelB.currentModel);
    await repository.applyModel('sample-main', modelC.currentModel);
    expect(repository.previewState.getState()).toMatchObject({ phase: 'ready', state: modelC });
    if (outcome === 'success') finishPrevious({ ...control('sample-main'), ...modelB });
    else failPrevious(new Error('Previous sample read failed'));
    await expect(previous).resolves.toBeUndefined();
    expect(repository.previewState.getState()).toMatchObject({ phase: 'ready', state: modelC });
  });

  it.each(['another target', 'live state'] as const)('does not replace the preview when a model read finishes after selecting %s', async (destination) => {
    let finishRead!: (snapshot: AgentControlSnapshot) => void;
    const state = vi.fn().mockResolvedValueOnce({ ...control('sample-main'), ...modelA })
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
      .mockResolvedValueOnce({ ...control('sample-other'), ...modelC });
    const repository = createAgentRunRepository(client({ state }));
    await repository.loadPreview('sample-main');
    const refreshing = repository.applyModel('sample-main', modelB.currentModel);
    if (destination === 'another target') await repository.loadPreview('sample-other');
    else {
      // The renderer clears the history preview when a live control snapshot arrives.
      repository.syncControl({ 'sample-main': { ...control('sample-main'), ...modelB } });
      repository.clearPreview('sample-main');
    }
    const selected = repository.previewState.getState();
    finishRead({ ...control('sample-main'), ...modelB });
    await refreshing;
    expect(repository.previewState.getState()).toBe(selected);
  });

  it('keeps the ready model pair and reports a failed refresh, then updates both fields on retry', async () => {
    const state = vi.fn().mockResolvedValueOnce({ ...control('sample-main'), ...modelA })
      .mockRejectedValueOnce(new Error('Sample preview read failed'))
      .mockResolvedValueOnce({ ...control('sample-main'), ...modelB });
    const repository = createAgentRunRepository(client({ state }));
    await repository.loadPreview('sample-main');
    const previous = repository.previewState.getState();

    await expect(repository.applyModel('sample-main', modelB.currentModel)).rejects.toThrow('Sample preview read failed');
    expect(repository.previewState.getState()).toBe(previous);
    await repository.applyModel('sample-main', modelB.currentModel);
    expect(repository.previewState.getState()).toMatchObject({ phase: 'ready', state: modelB });
  });

  it('applies the canonical renamed snapshot immediately to the list and ready preview', async () => {
    const original = run('sample-main');
    const rename = vi.fn(async () => ({
      ...original,
      runConfig: { ...original.runConfig, name: 'Revised title' },
    }));
    const list = vi.fn(async () => [original]);
    const repository = createAgentRunRepository(client({
      list,
      rename,
      state: vi.fn(async () => control('sample-main')),
    }));
    await repository.refresh();
    await repository.loadPreview('sample-main');
    repository.applyConversation({
      agentId: 'sample-main',
      index: 4,
      entry: {
        t: 'msg', role: 'assistant', id: 'sample-reply', ts: 4000, content: 'Example reply',
      },
      messages: {
        latestMessage: { index: 4, timestamp: 4000 },
        latestAssistantIndex: 4,
        readThroughIndex: -1,
      },
    });

    await repository.rename('sample-main', 'Revised title');

    expect(rename).toHaveBeenCalledExactlyOnceWith('sample-main', 'Revised title');
    expect(list).toHaveBeenCalledOnce();
    expect(repository.listState.getState().runs[0]).toMatchObject({
      runConfig: { name: 'Revised title' },
      messages: { latestMessage: { index: 4 } },
    });
    expect(repository.previewState.getState()).toMatchObject({
      phase: 'ready',
      state: { runConfig: { name: 'Revised title' } },
    });
  });

  it('fences an older list response after a rename succeeds', async () => {
    const original = run('sample-main');
    let finishRefresh!: (runs: AgentRunSnapshot[]) => void;
    const list = vi.fn()
      .mockResolvedValueOnce([original])
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishRefresh = resolve;
      }));
    const repository = createAgentRunRepository(client({
      list,
      rename: vi.fn(async () => ({
        ...original,
        runConfig: { ...original.runConfig, name: 'Revised title' },
      })),
    }));
    await repository.refresh();

    const refreshing = repository.refresh();
    await repository.rename('sample-main', 'Revised title');
    finishRefresh([original]);
    await refreshing;

    expect(repository.listState.getState()).toMatchObject({
      phase: 'ready',
      runs: [{ runConfig: { name: 'Revised title' } }],
    });
  });

  it('keeps an initial list request usable when an active-only row is renamed', async () => {
    const original = run('sample-main');
    let finishList!: (runs: AgentRunSnapshot[]) => void;
    const repository = createAgentRunRepository(client({
      list: vi.fn(() => new Promise<AgentRunSnapshot[]>((resolve) => {
        finishList = resolve;
      })),
      rename: vi.fn(async () => ({
        ...original,
        runConfig: { ...original.runConfig, name: 'Revised title' },
      })),
    }));

    const listing = repository.refresh();
    await repository.rename('sample-main', 'Revised title');
    finishList([original]);
    await listing;

    expect(repository.listState.getState()).toMatchObject({
      phase: 'ready',
      runs: [{ runConfig: { name: 'Revised title' } }],
    });
  });

  it('uses the renamed list title when an older preview response arrives later', async () => {
    const original = run('sample-main');
    let finishPreview!: (state: AgentControlSnapshot) => void;
    const repository = createAgentRunRepository(client({
      list: vi.fn(async () => [original]),
      state: vi.fn(() => new Promise<AgentControlSnapshot | null>((resolve) => {
        finishPreview = resolve;
      })),
      rename: vi.fn(async () => ({
        ...original,
        runConfig: { ...original.runConfig, name: 'Revised title' },
      })),
    }));
    await repository.refresh();

    const preview = repository.loadPreview('sample-main');
    await repository.rename('sample-main', 'Revised title');
    finishPreview(control('sample-main'));
    await preview;

    expect(repository.previewState.getState()).toMatchObject({
      phase: 'ready',
      state: { runConfig: { name: 'Revised title' } },
    });
  });
});
