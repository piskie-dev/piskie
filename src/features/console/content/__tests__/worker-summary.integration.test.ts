import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry, MsgEntry, ToolEntry } from '@shared/types/agent-control';
import { createTranscriptStore, type TranscriptStore } from '@/domains/transcript/transcript-store';
import { RendererRuntimeProvider } from '@/renderer-runtime/RendererRuntimeProvider';
import type { RendererRuntime } from '@/renderer-runtime/renderer-runtime';
import { useTranscript } from '../../data/useTranscript';
import type { WorkerVM } from '../../data/vm';
import { clearTranscriptPresentationMemory } from '../transcriptPresentationMemory';

const state = vi.hoisted(() => ({ workers: [] as WorkerVM[] }));
vi.mock('../../data/vm', async (original) => ({
  ...await original<typeof import('../../data/vm')>(),
  useWorkerVM: (_parent: string, id: string) => state.workers.find((worker) => worker.id === id) ?? null,
}));
vi.mock('@/utils/platform', () => ({ isMacOSPlatform: () => false }));
vi.mock('@/components/content-links', () => ({
  LinkedMarkdown: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  LinkedText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

let Transcript: typeof import('../Transcript').Transcript;
let ThreadCell: typeof import('../ThreadCell').ThreadCell;
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let store: TranscriptStore;
let runtime: RendererRuntime;
let history: Record<string, ConversationEntry[]>;
let initialFrom: number;
const openWorker = vi.fn();
const RuntimeProvider = RendererRuntimeProvider as ComponentType<{ readonly runtime: RendererRuntime }>;
const conversation = vi.fn(async (id: string, page: { direction: string; from?: number; before?: number }) => {
  const entries = history[id] ?? [];
  const from = page.direction === 'tail' && id === 'sample-parent' ? initialFrom
    : page.direction === 'forward' ? page.from ?? 0 : 0;
  const end = page.direction === 'backward' ? page.before : undefined;
  return { from, total: entries.length, entries: entries.slice(from, end) };
});

const worker = (id = 'sample-child'): WorkerVM => ({
  id, mainAgentId: 'sample-parent', subject: 'Sample task', type: 'local-worker', status: 'running',
  phase: 'executing', interrupted: false, canPause: true, model: 'sample-model',
  reasoningOverride: { kind: 'provider-default' }, approvalMode: 'auto', conversationLength: 0,
  runMetrics: {} as WorkerVM['runMetrics'], pendingEvents: [], imageNodeIds: [], browserReady: false, taskState: { inputAt: 1000 },
});
const user = (): MsgEntry => ({
  t: 'msg', ts: 1000, id: 'sample-user', role: 'user', subtype: 'user_input', content: 'Inspect a sample.',
});
const assistant = (id: string, content: MsgEntry['content'], ts: number): MsgEntry => ({
  t: 'msg', id, role: 'assistant', ts, content,
});
const result = (id: string, ts: number, text = 'Sample result', ok = true): ToolEntry => ({
  t: 'tool', toolUseId: id, ts, ok, result: [{ type: 'text', text }],
});
const create = (id = 'sample-create') => ({
  type: 'tool_use' as const, id, name: 'subagent', input: { subject: 'Sample task', type: 'local-worker', prompt: 'Inspect a sample.' },
});
const send = (id = 'sample-send') => ({
  type: 'tool_use' as const, id, name: 'send_event', input: { targetId: 'sample-child', message: 'Inspect the next sample.' },
});
const notice = (id = 'sample-notice', ts = 5000): MsgEntry => ({
  t: 'msg', id, ts, role: 'user', subtype: 'subagent_notification',
  content: '<subagent_event id="sample-child" type="message">Sample update.</subagent_event>',
});
const createdEntries = (): ConversationEntry[] => [
  user(), assistant('sample-creation-message', [create()], 2000),
  result('sample-create', 3000, 'subagentId: sample-child'), assistant('sample-first-final', 'First sample reply.', 4000),
];
const dispatchedEntries = (): ConversationEntry[] => [
  ...createdEntries(), notice(), assistant('sample-dispatch-message', [
    { type: 'tool_use', id: 'sample-check', name: 'shell', input: { description: 'Check a sample', command: 'sample-command' } }, send(),
  ], 6000), result('sample-check', 6500), result('sample-send', 7000),
  assistant('sample-second-final', 'Second sample reply.', 8000),
];
const childEntries = (): ConversationEntry[] => [assistant('sample-child-message', [
  { type: 'text', text: 'Earlier sample progress.' },
  { type: 'tool_use', id: 'sample-child-tool', name: 'shell', input: { description: 'Read sample records', command: 'sample-command' } },
], 2200)];

function configure(parent = createdEntries(), child = childEntries(), from = 0) {
  history = { 'sample-parent': parent, 'sample-child': child };
  initialFrom = from;
  store = createTranscriptStore({ conversation });
  runtime = { transcript: store } as unknown as RendererRuntime;
}
function View({ id, instance }: { id: string; instance: string }) {
  const transcript = useTranscript(id);
  return createElement('section', { 'data-target': id }, createElement(Transcript, {
    key: instance, memoryKey: id, nodes: transcript.nodes, responses: transcript.responses,
    hasEarlier: transcript.hasEarlier, onLoadEarlier: transcript.loadEarlier, processSettled: true,
    workers: state.workers,
    renderNode: (cell) => createElement(ThreadCell, {
      cell, mainAgentId: 'sample-parent', workers: state.workers, onOpenWorker: openWorker,
    }),
  }));
}
async function mount(instance = 'sample-view', showChild = true) {
  await act(async () => root.render(createElement(RuntimeProvider, { runtime },
    createElement(View, { id: 'sample-parent', instance }),
    showChild ? createElement(View, { id: 'sample-child', instance }) : null,
  )));
}
async function append(id: string, entry: ConversationEntry, requestId?: string) {
  const entries = history[id]!;
  const index = entries.length;
  entries.push(entry);
  await act(async () => store.applyConversation({ agentId: id, index, entry, requestId }));
}
const main = () => container.querySelector<HTMLElement>('[data-target="sample-parent"]')!;
const child = () => container.querySelector<HTMLElement>('[data-target="sample-child"]')!;
const activities = () => [...main().querySelectorAll<HTMLElement>('[class*="workerCreationAction"]')];
const process = (id: string) => main().querySelector<HTMLElement>(`[data-group-id="${id}"]`)!;
const header = (id: string) => process(id).querySelector<HTMLButtonElement>('button')!;
async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => element!.click());
}

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  dom.window.Element.prototype.getAnimations = () => [];
  dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
  for (const key of ['window', 'document', 'navigator', 'Element', 'HTMLElement'] as const) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  ({ Transcript } = await import('../Transcript'));
  ({ ThreadCell } = await import('../ThreadCell'));
});
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  clearTranscriptPresentationMemory();
  vi.clearAllMocks();
  state.workers = [worker()];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  store.close();
  container.remove();
});
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

describe('shared child content subscription', () => {
  it.each([true, false])('keeps the actual last tool after its result arrives (ok: %s)', async (ok) => {
    configure();
    await mount();
    const lastToolTitle = () => child().querySelector('[data-node-id="sample-child-tool"] [title]')?.getAttribute('title');
    expect(activities().map((element) => element.textContent)).toEqual([` · ${lastToolTitle()}`]);
    await append('sample-child', result('sample-child-tool', 3200, 'Sample result', ok));
    expect(activities().map((element) => element.textContent)).toEqual([` · ${lastToolTitle()}`]);
    expect(activities()[0]?.textContent).toBe(` · Run command · ${ok ? 'Read sample records' : 'Sample result'}`);
    await append('sample-child', assistant('sample-last-text', 'Latest sample progress.', 3300));
    expect(activities().map((element) => element.textContent)).toEqual([' · Latest sample progress.']);
    expect(child().querySelector('[data-node-id="sample-last-text"]')?.textContent).toBe('Latest sample progress.');
    expect(conversation.mock.calls.filter(([id]) => id === 'sample-child')).toHaveLength(1);
  });

  it('updates live reasoning and text from the same session before and after canonical replacement', async () => {
    configure();
    await mount();
    const session = store.session('sample-child');
    const emit = async (sequence: number, kind: 'think' | 'text', delta: string) => {
      await act(async () => session.applyLive({
        agentId: 'sample-child', requestId: 'sample-request', runId: 'sample-run', attempt: 1, sequence, kind, delta,
      }, 'sample-request'));
    };
    await emit(1, 'think', 'Earlier sample line\nLatest reasoning');
    expect(child().querySelector('[data-think-summary]')?.textContent).toBe('Latest reasoning');
    expect(activities().map((element) => element.textContent)).toEqual([' · Thinking · Latest reasoning']);
    await emit(2, 'think', ' continues');
    expect(activities()[0]?.textContent).toBe(' · Thinking · Latest reasoning continues');
    await emit(3, 'text', 'Latest live sample');
    expect(activities()[0]?.textContent).toBe(' · Latest live sample');
    expect(child().querySelector('[data-node-id="live:sample-child:sample-request:1"]')?.textContent).toBe('Latest live sample');
    await act(async () => session.setRequestState({
      requestId: 'sample-request', phase: 'finished', outcome: 'success', attempt: 1, maxAttempts: 1,
    }));
    expect(activities()[0]?.textContent).toBe(' · Latest live sample');
    await append('sample-child', assistant('sample-canonical', 'Canonical sample reply.', 3500), 'sample-request');
    expect(child().querySelector('[data-node-id^="live:"]')).toBeNull();
    expect(activities()[0]?.textContent).toBe(' · Canonical sample reply.');
    state.workers = state.workers.map((item) => ({ ...item, status: 'waiting', taskState: {
      inputAt: 9000, notification: { type: 'need_user_action', at: 10000 },
    } }));
    await mount();
    expect(activities()[0]?.textContent).toBe(' · Canonical sample reply.');
  });

  it('uses the latest collapsed tool group and ignores content hidden by the child renderer', async () => {
    configure(createdEntries(), [
      ...childEntries(), assistant('sample-second-tool-message', [{
        type: 'tool_use', id: 'sample-second-tool', name: 'example_tool', input: {},
      }], 2500), result('sample-second-tool', 3000),
      assistant('sample-hidden-message', [
        { type: 'redacted_thinking', data: 'sample-redacted' },
        { type: 'tool_use', id: 'sample-task', name: 'task', input: { action: 'update' } },
      ], 3100), result('sample-task', 3200),
      { t: 'msg', id: 'sample-empty', ts: 3400, role: 'user', subtype: 'user_input', content: '' },
    ]);
    await mount();
    const tools = child().querySelector<HTMLElement>('[data-transcript-group="tools"]')!;
    expect(tools.querySelector('button')?.textContent).toBe('example_tool · Sample result');
    expect(activities()[0]?.textContent).toBe(' · example_tool · Sample result');
    await click(tools.querySelector('button'));
    expect(child().querySelector('[data-node-id="sample-task"]')).toBeNull();
    expect(child().querySelector('[data-node-id="sample-empty"]')?.textContent).toBe('');
    expect(activities()[0]?.textContent).toBe(' · example_tool · Sample result');
  });

  it('keeps a subject-only row when no child content is visible', async () => {
    configure(createdEntries(), []);
    await mount();
    expect(activities()).toHaveLength(0);
    expect(main().querySelector('[class*="workerCreationSubject"]')?.textContent).toBe('Sample task');
  });
});

describe('one current dispatch owner', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'keeps one live preview and preserves history across process open states (%s, %s)', async (firstOpen, nextOpen) => {
      configure(dispatchedEntries());
      await mount();
      const firstId = 'process:sample-user';
      const nextId = 'process:after:sample-first-final';
      if (firstOpen) await click(header(firstId));
      if (nextOpen) await click(header(nextId));
      const assertOwnership = () => {
        expect(activities()).toHaveLength(1);
        expect(process(nextId).contains(activities()[0]!)).toBe(true);
        expect(process(firstId).querySelector('[class*="workerCreationAction"]')).toBeNull();
        expect(header(firstId).textContent).not.toContain('not finished');
        expect(header(nextId).textContent).toContain('1 worker not finished');
        expect(main().querySelector('[data-node-id="sample-first-final"]')?.closest('[data-transcript-group="process"]')).toBeNull();
        expect(main().querySelector('[data-node-id="sample-second-final"]')?.closest('[data-transcript-group="process"]')).toBeNull();
      };
      assertOwnership();
      if (firstOpen) {
        expect(process(firstId).querySelector('[data-node-id="sample-create"]')?.textContent).toContain('Sample task');
        expect(process(firstId).querySelector('[data-node-id="sample-create"] [data-live="true"]')).toBeNull();
      }
      if (nextOpen) {
        await click(process(nextId).querySelector('[data-transcript-group="tools"] > button'));
        expect(process(nextId).querySelector('[data-node-id="sample-send"]')).not.toBeNull();
        assertOwnership();
      }
      await click(activities()[0]!.closest('button'));
      expect(openWorker).toHaveBeenCalledExactlyOnceWith('sample-child');
      const session = store.session('sample-child');
      await act(async () => session.applyLive({
        agentId: 'sample-child', requestId: 'sample-request', runId: 'sample-run', sequence: 1,
        attempt: 1, kind: 'text', delta: 'Latest owner sample',
      }, 'sample-request'));
      assertOwnership();
      expect(activities()[0]?.textContent).toBe(' · Latest owner sample');
      await mount('sample-remount');
      assertOwnership();
      expect(header(firstId).getAttribute('aria-expanded')).toBe(String(firstOpen));
      expect(header(nextId).getAttribute('aria-expanded')).toBe(String(nextOpen));
    },
  );

  it('moves only after successful delivery, including active work before it folds', async () => {
    configure();
    await mount();
    const first = process('process:sample-user');
    await append('sample-parent', notice());
    await append('sample-parent', assistant('sample-failed-send-message', [send('sample-failed-send')], 6000));
    expect(first.contains(activities()[0]!)).toBe(true);
    await append('sample-parent', result('sample-failed-send', 7000, 'Sample delivery failed', false));
    expect(first.contains(activities()[0]!)).toBe(true);
    await append('sample-parent', assistant('sample-next-send-message', [send('sample-next-send')], 8000));
    expect(first.contains(activities()[0]!)).toBe(true);
    await append('sample-parent', result('sample-next-send', 9000));
    expect(activities()).toHaveLength(1);
    expect(first.contains(activities()[0]!)).toBe(false);
    expect(first.querySelector('[data-worker-summary]')).toBeNull();
    await append('sample-parent', assistant('sample-second-final', 'Second reply.', 10000));
    expect(process('process:after:sample-first-final').contains(activities()[0]!)).toBe(true);
    await click(header('process:sample-user'));
    expect(first.querySelector('[data-node-id="sample-create"]')).not.toBeNull();
    expect(first.querySelector('[class*="workerCreationAction"]')).toBeNull();
  });

  it('keeps different worker IDs with the same subject and moves only the addressed one across turns', async () => {
    configure([
      user(), assistant('sample-creation-message', [create(), create('sample-other-create')], 2000),
      result('sample-create', 3000, 'subagentId: sample-child'),
      result('sample-other-create', 3000, 'subagentId: sample-other-child'),
      assistant('sample-first-final', 'First reply.', 4000),
    ]);
    state.workers.push(worker('sample-other-child'));
    history['sample-other-child'] = [assistant('sample-other-progress', 'Other sample progress.', 2500)];
    await mount();
    expect(activities()).toHaveLength(2);
    expect(header('process:sample-user').textContent).toContain('2 workers not finished');
    await append('sample-parent', { ...user(), id: 'sample-next-user', ts: 5000 });
    await append('sample-parent', assistant('sample-dispatch-message', [send()], 6000));
    await append('sample-parent', result('sample-send', 7000));
    await append('sample-parent', assistant('sample-next-final', 'Next reply.', 8000));
    expect(activities()).toHaveLength(2);
    expect(process('process:sample-user').querySelectorAll('[class*="workerCreationAction"]')).toHaveLength(1);
    expect(process('process:sample-next-user').querySelectorAll('[class*="workerCreationAction"]')).toHaveLength(1);
    expect(header('process:sample-user').textContent).toContain('1 worker not finished');
    expect(header('process:sample-next-user').textContent).toContain('1 worker not finished');
  });

  it('derives ownership again when pagination reveals the creation record', async () => {
    configure(dispatchedEntries(), childEntries(), 4);
    await mount();
    expect(activities()).toHaveLength(0);
    expect(store.session('sample-parent').state.getState().hasEarlier).toBe(true);
    await act(async () => store.session('sample-parent').loadEarlier());
    expect(activities()).toHaveLength(1);
    expect(process('process:after:sample-first-final').contains(activities()[0]!)).toBe(true);
    expect(process('process:sample-user').querySelector('[data-worker-summary]')).toBeNull();
    expect(store.session('sample-parent').state.getState().projection.nodes.filter((node) => node.kind === 'worker')).toHaveLength(1);
  });

  it('replays repaired gaps and duplicate canonical observations without retaining an old owner', async () => {
    configure();
    await mount();
    history['sample-parent'] = dispatchedEntries();
    await act(async () => store.applyConversation({
      agentId: 'sample-parent', index: 8, entry: history['sample-parent']![8]!,
    }));
    await vi.waitFor(() => expect(activities()).toHaveLength(1));
    expect(process('process:after:sample-first-final').contains(activities()[0]!)).toBe(true);
    await act(async () => store.applyConversation({
      agentId: 'sample-parent', index: 7, entry: history['sample-parent']![7]!,
    }));
    expect(activities()).toHaveLength(1);
    await act(async () => root.render(null));
    store.close();
    clearTranscriptPresentationMemory();
    configure(dispatchedEntries());
    await mount('sample-cold-replay');
    expect(activities()).toHaveLength(1);
    expect(process('process:after:sample-first-final').contains(activities()[0]!)).toBe(true);
    expect(header('process:sample-user').textContent).not.toContain('not finished');
  });
});
