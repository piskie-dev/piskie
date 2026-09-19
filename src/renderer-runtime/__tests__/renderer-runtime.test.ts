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
import {
  getQuestionDraft,
  getQuestionDraftVersion,
  questionDraftKey,
  useQuestionDraftStore,
  type QuestionDraftKey,
} from '../../features/console/data/question-drafts';

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

function questionState(agentId: string, requestId: string): AgentControlSnapshot {
  return {
    ...state(agentId),
    pendingQuestion: {
      id: requestId,
      agentId,
      questions: [{ question: 'Sample question?', multiSelect: false }],
      timestamp: new Date(0),
    },
  };
}

function writeQuestionDraft(agentId: string, requestId: string, custom: string): QuestionDraftKey {
  const key = questionDraftKey(agentId, requestId);
  useQuestionDraftStore.getState().setItem(
    key,
    0,
    { selected: [], custom },
    getQuestionDraftVersion(key),
  );
  return key;
}

function harness() {
  let stateListener: ((event: AgentControlChangedEvent) => void) | undefined;
  let liveListener: ((event: AgentLiveContentDelta) => void) | undefined;
  let conversationListener: ((event: ConversationAppendEvent) => void) | undefined;
  let resolveStates: ((states: Record<string, AgentControlSnapshot>) => void) | undefined;
  const disposers = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const listStates = vi.fn(() => new Promise<Record<string, AgentControlSnapshot>>((resolve) => {
    resolveStates = resolve;
  }));
  const api = {
    runtime: { status: vi.fn(async () => ({ ready: true })) },
    schedules: {
      observeChanges: vi.fn(() => disposers[4]),
    },
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

  it('reconciles question drafts against the final authoritative pending identity', async () => {
    const current = writeQuestionDraft('sample-main', 'question-current', 'Current answer');
    const stale = writeQuestionDraft('sample-main', 'question-stale', 'Stale answer');
    const orphan = writeQuestionDraft('sample-orphan', 'question-orphan', 'Orphan answer');
    useComposerDraftStore.getState().appendFiles(stale, [{
      id: 'sample-file', name: 'sample.txt', path: '/sample/sample.txt',
    }]);
    const test = harness();
    const runtime = createRuntime(test.api, test.services, { screenFeeds: test.screenFeeds });
    const started = runtime.start();
    await Promise.resolve();
    test.resolveStates({ 'sample-main': questionState('sample-main', 'question-current') });
    await started;

    expect(getQuestionDraft(current)[0]?.custom).toBe('Current answer');
    expect(getQuestionDraft(stale)).toEqual([]);
    expect(getQuestionDraft(orphan)).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[stale]).toBeUndefined();

    const next = writeQuestionDraft('sample-main', 'question-next', 'Next answer');
    test.emitState({ agentId: 'sample-main', state: questionState('sample-main', 'question-next') });
    expect(getQuestionDraft(current)).toEqual([]);
    expect(getQuestionDraft(next)[0]?.custom).toBe('Next answer');

    test.emitState({ agentId: 'sample-main', state: state('sample-main') });
    expect(getQuestionDraft(next)).toEqual([]);
    await runtime.stop();
  });

  it.each(['state-first', 'conversation-first'])('notifies only after canonical text and settled control, never from streaming (%s)', async (order) => {
    const test = harness();
    const runtime = createRuntime(test.api, test.services, { screenFeeds: test.screenFeeds });
    const agentId = 'sample-main';
    const requestId = 'sample-request';
    const messages = { latestMessage: { index: 0, timestamp: 1000 }, latestAssistantIndex: -1, readThroughIndex: 0 };
    runtime.agentRuns.listState.setState({ runs: [{ agentId, messages } as AgentRunSnapshot] });
    const started = runtime.start();
    await Promise.resolve();
    test.resolveStates({ [agentId]: { ...state(agentId, undefined, requestId), phase: 'thinking', activeStartedAt: 1000 } });
    await started;
    const unread = () => runtime.agentRuns.listState.getState().attentionByAgentId[agentId]?.unread;
    test.emitLive({ agentId, requestId, runId: 'sample-run', attempt: 1, sequence: 1, kind: 'text', delta: 'Example streaming text' });
    expect(unread()).toBe(false);
    const settled = {
      ...state(agentId),
      aiRequestState: { requestId, phase: 'finished' as const, outcome: 'success' as const, attempt: 0, maxAttempts: 1 },
    };
    test.emitState({ agentId, state: { ...settled, phase: 'thinking', activeStartedAt: 1000 } });
    expect(unread()).toBe(false);
    if (order === 'state-first') test.emitState({ agentId, state: settled });
    expect(unread()).toBe(false);
    test.emitConversation({
      agentId, requestId, index: 1,
      entry: { t: 'msg', role: 'assistant', id: 'sample-message', ts: 2000, content: 'Example final reply' },
      messages: { latestMessage: { index: 1, timestamp: 2000 }, latestAssistantIndex: 1, readThroughIndex: 0 },
    });
    if (order === 'conversation-first') {
      expect(unread()).toBe(false);
      test.emitState({ agentId, state: settled });
    }
    expect(unread()).toBe(true);
    // Starting another process does not erase an unread final answer from the last one.
    test.emitState({ agentId, state: { ...state(agentId, undefined, 'next-request'), phase: 'thinking', activeStartedAt: 3000 } });
    expect(unread()).toBe(true);
    await runtime.stop();
  });

  it('keeps composer drafts when an agent stops and clears every draft at its owning lifecycle', async () => {
    const test = harness();
    const api = { ...test.api, agentRuns: { delete: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]) } } as unknown as PiskieDesktopApi;
    const runtime = createRuntime(api, test.services, { screenFeeds: test.screenFeeds });
    const started = runtime.start();
    await Promise.resolve();
    test.resolveStates({
      example: questionState('example', 'question-one'),
      other: questionState('other', 'question-other'),
    });
    await started;
    const drafts = useComposerDraftStore.getState();
    drafts.setDraft('agent:example', 'Example body');
    drafts.setDraft('worker:example:child', 'Worker body');
    drafts.setDraft('agent:other', 'Other body');
    const stoppedQuestion = writeQuestionDraft('example', 'question-one', 'Example answer');
    const otherQuestion = writeQuestionDraft('other', 'question-other', 'Other answer');
    test.emitState({ agentId: 'example', state: null });
    expect(useComposerDraftStore.getState().drafts['agent:example']?.text).toBe('Example body');
    expect(getQuestionDraft(stoppedQuestion)).toEqual([]);
    expect(getQuestionDraft(otherQuestion)[0]?.custom).toBe('Other answer');
    const deletedQuestion = writeQuestionDraft('example', 'question-two', 'Unsynced answer');
    useComposerDraftStore.getState().appendFiles(deletedQuestion, [{
      id: 'sample-file', name: 'sample.txt', path: '/sample/sample.txt',
    }]);
    await runtime.agentRuns.delete('example');
    expect(useComposerDraftStore.getState().drafts['agent:example']).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts['worker:example:child']).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts['agent:other']?.text).toBe('Other body');
    expect(getQuestionDraft(deletedQuestion)).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[deletedQuestion]).toBeUndefined();
    expect(getQuestionDraft(otherQuestion)[0]?.custom).toBe('Other answer');
    await runtime.stop();
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    expect(getQuestionDraft(otherQuestion)).toEqual([]);
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
