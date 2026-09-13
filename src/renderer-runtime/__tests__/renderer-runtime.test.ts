import { describe, expect, it, vi } from 'vitest';
import type { PiskieDesktopApi } from '@shared/electron-contracts/api';
import type { AgentLiveContentDelta } from '@shared/electron-contracts/agents';
import type {
  AgentControlChangedEvent,
  AgentControlSnapshot,
  AgentRunSnapshot,
} from '@shared/electron-contracts/agent-runs';
import type { ConversationAppendEvent } from '@shared/types';
import type { ScreenFeedRegistry } from '../../domains/screen-feed/screen-feed-registry';
import { createRuntime, type RendererRuntimeServices } from '../renderer-runtime';
import { useComposerDraftStore } from '../../features/console/data/composer-drafts';

function state(
  agentId: string,
  childId?: string,
  requestId?: string,
): AgentControlSnapshot {
  return {
    agentId,
    phase: 'waiting',
    children: childId ? [{ id: childId, phase: 'waiting' }] : [],
    runConfig: { name: agentId },
    ...(requestId && {
      aiRequestState: {
        requestId,
        phase: 'requesting',
        attempt: 1,
        maxAttempts: 2,
      },
    }),
  } as AgentControlSnapshot;
}

function harness() {
  let stateListener: ((event: AgentControlChangedEvent) => void) | undefined;
  let liveListener: ((event: AgentLiveContentDelta) => void) | undefined;
  let conversationListener: ((event: ConversationAppendEvent) => void) | undefined;
  let resolveStates: ((states: Record<string, AgentControlSnapshot>) => void) | undefined;
  const disposers = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const listStates = vi.fn(() => new Promise<Record<string, AgentControlSnapshot>>((resolve) => {
    resolveStates = resolve;
  }));
  const api = {
    runtime: { status: vi.fn(async () => ({ ready: true })) },
    agents: {
      listStates,
      interrupt: vi.fn(async () => undefined),
      observeState: vi.fn((listener: typeof stateListener) => {
        stateListener = listener;
        return disposers[0];
      }),
      observeConversation: vi.fn((listener: (event: ConversationAppendEvent) => void) => {
        conversationListener = listener;
        return disposers[1];
      }),
      observeLiveContent: vi.fn((listener: typeof liveListener) => {
        liveListener = listener;
        return disposers[2];
      }),
    },
  } as unknown as PiskieDesktopApi;
  const services: RendererRuntimeServices = {
    startSubscriptions: vi.fn((register) => register(disposers[3]!)),
    bootstrap: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  const screenFeeds = {
    acquireViewport: vi.fn(),
    activeFeedCount: vi.fn(() => 0),
    close: vi.fn(async () => undefined),
  } as unknown as ScreenFeedRegistry;
  return {
    api,
    services,
    screenFeeds,
    disposers,
    resolveStates: (states: Record<string, AgentControlSnapshot>) => resolveStates?.(states),
    emitState: (event: AgentControlChangedEvent) => stateListener?.(event),
    emitLive: (event: AgentLiveContentDelta) => liveListener?.(event),
    emitConversation: (event: ConversationAppendEvent) => conversationListener?.(event),
  };
}

describe('RendererRuntime', () => {
  it('subscribes once, hydrates subscribe-first, and replays buffered events', async () => {
    const test = harness();
    const runtime = createRuntime(test.api, test.services, { screenFeeds: test.screenFeeds });
    const transcript = runtime.transcript.session('main');
    const firstStart = runtime.start();
    const secondStart = runtime.start();

    test.emitState({ agentId: 'main', state: state('main', 'worker', 'request') });
    const live = {
      agentId: 'main',
      requestId: 'request',
      runId: 'run',
      attempt: 2,
      sequence: 1,
      kind: 'text',
      delta: 'hello',
    } satisfies AgentLiveContentDelta;
    test.emitLive(live);
    await Promise.resolve();
    test.resolveStates({});
    await Promise.all([firstStart, secondStart]);

    expect(test.api.agents.observeState).toHaveBeenCalledTimes(1);
    expect(test.api.agents.observeConversation).toHaveBeenCalledTimes(1);
    expect(test.api.agents.observeLiveContent).toHaveBeenCalledTimes(1);
    expect(runtime.agentControl.resolve('worker')).toMatchObject({ mainAgentId: 'main' });
    expect(runtime.phase()).toBe('ready');
    await vi.waitFor(() => {
      expect(transcript.state.getState().live).toMatchObject({
        phase: 'streaming',
        attempt: 2,
        parts: [{ kind: 'text', markdown: 'hello' }],
      });
    });
  });

  it('updates sidebar messages only from canonical main message observations, never token or control updates', async () => {
    const test = harness();
    const runtime = createRuntime(test.api, test.services, { screenFeeds: test.screenFeeds });
    const messages = { latestMessage: { index: 0, timestamp: 1000 }, latestAssistantIndex: 0, readThroughIndex: 0 };
    runtime.agentRuns.listState.setState({ runs: [{ agentId: 'sample-main', messages } as AgentRunSnapshot] });
    const started = runtime.start();
    await Promise.resolve();
    test.resolveStates({ 'sample-main': state('sample-main', undefined, 'sample-request') });
    await started;
    test.emitLive({ agentId: 'sample-main', requestId: 'sample-request', runId: 'sample-run', attempt: 1, sequence: 1, kind: 'text', delta: 'Example token' });
    test.emitState({ agentId: 'sample-main', state: state('sample-main') });
    test.emitConversation({ agentId: 'sample-worker', index: 0, entry: { t: 'msg', role: 'assistant', id: 'sample-worker-message', ts: 2000, content: 'Example internal reply' } });
    expect(runtime.agentRuns.listState.getState().runs[0]!.messages).toBe(messages);
    const next = { latestMessage: { index: 1, timestamp: 3000 }, latestAssistantIndex: 1, readThroughIndex: 0 };
    test.emitConversation({ agentId: 'sample-main', index: 1, entry: { t: 'msg', role: 'assistant', id: 'sample-main-message', ts: 3000, content: 'Example reply' }, messages: next });
    expect(runtime.agentRuns.listState.getState().runs[0]!.messages).toEqual(next);
    await runtime.stop();
  });

  it('keeps drafts when an agent stops, clears the deleted owner and workers, and clears all on renderer stop', async () => {
    const test = harness();
    const api = { ...test.api, agentRuns: { delete: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]) } } as unknown as PiskieDesktopApi;
    const runtime = createRuntime(api, test.services, { screenFeeds: test.screenFeeds });
    const started = runtime.start(); await Promise.resolve(); test.resolveStates({}); await started;
    const drafts = useComposerDraftStore.getState();
    drafts.setDraft('agent:example', 'Example body');
    drafts.setDraft('worker:example:child', 'Worker body');
    drafts.setDraft('agent:other', 'Other body');
    test.emitState({ agentId: 'example', state: null });
    expect(useComposerDraftStore.getState().drafts['agent:example']?.text).toBe('Example body');
    await runtime.agentRuns.delete('example');
    expect(useComposerDraftStore.getState().drafts['agent:example']).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts['worker:example:child']).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts['agent:other']?.text).toBe('Other body');
    await runtime.stop();
    expect(useComposerDraftStore.getState().drafts).toEqual({});
  });

  it('disposes every subscription once and makes stop idempotent', async () => {
    const test = harness();
    const runtime = createRuntime(test.api, test.services, { screenFeeds: test.screenFeeds });
    const started = runtime.start();
    await Promise.resolve();
    test.resolveStates({ main: state('main') });
    await started;

    await Promise.all([runtime.stop(), runtime.stop()]);

    for (const dispose of test.disposers) expect(dispose).toHaveBeenCalledTimes(1);
    expect(test.services.stop).toHaveBeenCalledTimes(1);
    expect(test.screenFeeds.close).toHaveBeenCalledTimes(1);
    expect(runtime.phase()).toBe('stopped');
  });

  it('rolls back established subscriptions when startup fails', async () => {
    const test = harness();
    test.api.runtime.status = vi.fn(async () => {
      throw new Error('offline');
    });
    const runtime = createRuntime(test.api, test.services, { screenFeeds: test.screenFeeds });

    await expect(runtime.start()).rejects.toThrow('offline');

    for (const dispose of test.disposers) expect(dispose).toHaveBeenCalledTimes(1);
    expect(test.services.stop).toHaveBeenCalledTimes(1);
    expect(test.screenFeeds.close).toHaveBeenCalledTimes(1);
    expect(runtime.phase()).toBe('failed');
  });
});
