import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry, MsgEntry, PersistedMessageBlock, ToolEntry } from '@shared/types/agent-control';
import { TranscriptProjector } from '@/domains/transcript/projector';
import { createTranscriptSession } from '@/domains/transcript/transcript-session';
import { projectLiveNodes } from '@/domains/transcript/live-generation';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import type { WorkerRef } from '../../data/vm';
import type { TranscriptProps } from '../Transcript';
import activeTextStyles from '../activeText.module.css';
import styles from '../Transcript.module.css';
import '@/i18n';

vi.mock('@/utils/platform', () => ({ isMacOSPlatform: () => false }));

let Transcript: typeof import('../Transcript').Transcript;
let ThreadCell: typeof import('../ThreadCell').ThreadCell;
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
const nodeRequire = createRequire(import.meta.url);
const previousCssLoader = nodeRequire.extensions['.css'];
const openFile = vi.fn();
const openWorker = vi.fn();
const onAction = vi.fn();

const user = (ts = 1000): MsgEntry => ({
  t: 'msg', id: 'sample-user', ts, role: 'user', subtype: 'user_input', content: 'Inspect the sample.',
});
const assistant = (id: string, content: MsgEntry['content'], ts = 2000): MsgEntry => ({
  t: 'msg', role: 'assistant', id, content, ts,
});
const call = (id: string, name = 'shell', input: Record<string, unknown> = {}): PersistedMessageBlock => ({
  type: 'tool_use', id, name, input,
});
const result = (id: string, text = 'Sample output'): ToolEntry => ({
  t: 'tool', toolUseId: id, ts: 3000, ok: true, result: [{ type: 'text', text }],
});
const defaultWorkers: readonly WorkerRef[] = [
  { id: 'sample-worker', subject: 'Sample work', type: 'local-worker', status: 'waiting' },
];
async function render(props: Omit<TranscriptProps, 'renderNode'>) {
  const workers = props.workers ?? defaultWorkers;
  await act(async () => root.render(createElement(Transcript, {
    ...props,
    workers,
    renderNode: (cell: TranscriptNode) => createElement(ThreadCell, {
      cell, conversationStatus: props.toolsActive ? 'running' : 'waiting',
      workers, onOpenWorker: openWorker, onOpenFileChange: openFile, onAction,
    }),
  })));
}
async function renderEntries(entries: readonly ConversationEntry[], options: Partial<TranscriptProps> = {}, pendingCallId?: string) {
  const projector = new TranscriptProjector();
  projector.reset(0, entries);
  if (pendingCallId) projector.setPendingCallId(pendingCallId);
  const { nodes, responses } = projector.snapshot();
  await render({ nodes, responses, ...options });
}
async function start(entries: readonly ConversationEntry[]) {
  const session = createTranscriptSession('sample-agent', {
    conversation: async () => ({ from: 0, total: entries.length, entries }),
  });
  await session.start();
  let index = entries.length;
  return {
    session,
    append: (entry: ConversationEntry, requestId?: string) => session.append({
      agentId: 'sample-agent', index: index++, requestId, entry,
    }),
    stream: (requestId: string, delta: string, kind: 'text' | 'think' = 'text', sequence = 1) => session.applyLive({
      agentId: 'sample-agent', requestId, runId: `run:${requestId}`, attempt: 1, sequence, kind, delta,
    }, requestId),
    finish: (requestId: string, outcome: 'success' | 'cancelled' = 'success') => session.setRequestState({
      requestId, phase: 'finished', outcome, attempt: 1, maxAttempts: 1,
    }),
    show: async (options: Partial<TranscriptProps> = {}) => {
      const snapshot = session.state.getState();
      await render({
        nodes: [...snapshot.projection.nodes, ...projectLiveNodes('sample-agent', snapshot.live)],
        responses: snapshot.projection.responses, ...options,
      });
    },
  };
}
const outsideIds = () => [...container.querySelectorAll<HTMLElement>('[data-node-id]')]
  .filter((element) => !element.closest('[data-transcript-group="process"]'))
  .map((element) => element.dataset.nodeId);
const node = (id: string) => container.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
const group = (kind: 'tools' | 'process') => container.querySelector<HTMLElement>(`[data-transcript-group="${kind}"]`);
const toggle = (kind: 'tools' | 'process') => group(kind)?.querySelector<HTMLButtonElement>('button') ?? null;
const click = async (element: HTMLElement | null) => {
  expect(element).not.toBeNull();
  await act(async () => element!.click());
};

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  dom.window.Element.prototype.getAnimations = () => [];
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DOMParser', 'MutationObserver'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  nodeRequire.extensions['.css'] = () => undefined;
  ({ Transcript } = await import('../Transcript'));
  ({ ThreadCell } = await import('../ThreadCell'));
});
beforeEach(() => {
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  await i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  if (previousCssLoader) nodeRequire.extensions['.css'] = previousCssLoader;
  else delete nodeRequire.extensions['.css'];
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('workers in collapsed processes', () => {
  const workers: readonly WorkerRef[] = [
    { id: 'worker-beta', subject: 'Review beta', type: 'local-worker', status: 'running' },
    { id: 'worker-complete', subject: 'Review complete', type: 'browser-worker', status: 'waiting' },
    { id: 'worker-alpha', subject: 'Review alpha', type: 'explore', status: 'thinking' },
  ];
  const entries = (startedAt = 1000): readonly ConversationEntry[] => [
    user(startedAt), assistant('sample-work', [
      call('before-one'), call('before-two'),
      call('worker-alpha-call', 'subagent', { subject: 'Review alpha', type: 'explore' }),
      call('between-call'),
      call('worker-complete-call', 'subagent', { subject: 'Review complete', type: 'browser-worker' }),
      call('worker-beta-call', 'subagent', { subject: 'Review beta', type: 'local-worker' }),
      call('after-one'), call('after-two'),
    ]),
    result('before-one'), result('before-two'), result('between-call'), result('after-one'), result('after-two'),
    result('worker-alpha-call', 'subagentId: worker-alpha'),
    result('worker-complete-call', 'subagentId: worker-complete'),
    result('worker-beta-call', 'subagentId: worker-beta'),
    assistant('sample-final', 'Final reply', 8000),
  ];
  const summaryIds = () => [...container.querySelectorAll<HTMLElement>('[data-worker-summary]')]
    .map((element) => element.dataset.workerSummary);
  const originalButton = (id: string) => container.querySelector<HTMLButtonElement>(`[data-node-id="${id}"] button`);
  const summaryButton = (id: string) => container.querySelector<HTMLButtonElement>(`[data-worker-summary="${id}"] button`);

  it.each([[1000, '用时 7秒'], [0, '执行过程']] as const)(
    'reuses active worker rows below %s, then restores the original order and navigation',
    async (startedAt, label) => {
      await renderEntries(entries(startedAt), { workers });
      const activeIds = ['worker-alpha-call', 'worker-beta-call'];
      const originalMarkup = activeIds.map((id) => originalButton(id)!.outerHTML);
      await renderEntries(entries(startedAt), { workers, processSettled: true });
      expect(toggle('process')!.textContent).toBe(label);
      expect(toggle('process')!.getAttribute('aria-expanded')).toBe('false');
      expect(summaryIds()).toEqual(activeIds);
      expect(activeIds.map((id) => summaryButton(id)!.outerHTML)).toEqual(originalMarkup);
      expect(group('process')!.querySelectorAll('[data-orb-variant="expanding"]')).toHaveLength(2);
      expect(group('process')!.querySelectorAll(`.${activeTextStyles.text}`)).toHaveLength(2);
      expect(toggle('process')!.querySelector(`.${activeTextStyles.text}`)).toBeNull();
      expect(container.textContent).not.toContain('Review complete');
      expect(group('process')!.querySelector('[data-node-id]')).toBeNull();

      await click(summaryButton('worker-alpha-call'));
      expect(openWorker).toHaveBeenCalledExactlyOnceWith('worker-alpha');
      expect(toggle('process')!.getAttribute('aria-expanded')).toBe('false');
      expect(group('process')!.querySelector('[data-node-id]')).toBeNull();
      expect(summaryIds()).toEqual(activeIds);

      await click(toggle('process'));
      expect(toggle('process')!.getAttribute('aria-expanded')).toBe('true');
      expect(summaryIds()).toEqual([]);
      for (const button of group('process')!.querySelectorAll<HTMLButtonElement>('[data-transcript-group="tools"] > button')) {
        await click(button);
      }
      expect([...group('process')!.querySelectorAll<HTMLElement>('[data-node-id]')].map((element) => element.dataset.nodeId))
        .toEqual(['before-one', 'before-two', 'worker-alpha-call', 'between-call', 'worker-complete-call', 'worker-beta-call', 'after-one', 'after-two']);
      expect(group('process')!.querySelectorAll('[data-live]')).toHaveLength(3);
      expect(originalButton('worker-complete-call')!.querySelector('svg.lucide-globe')).not.toBeNull();
      expect(originalButton('worker-alpha-call')!.outerHTML).toBe(originalMarkup[0]);
      await click(originalButton('worker-alpha-call'));
      expect(openWorker.mock.calls).toEqual([['worker-alpha'], ['worker-alpha']]);
      await click(toggle('process'));
      expect(summaryIds()).toEqual(activeIds);
      expect(group('process')!.querySelectorAll('[data-live]')).toHaveLength(2);
    },
  );

  it('removes each summary as existing worker statuses settle without changing transcript nodes', async () => {
    const projector = new TranscriptProjector();
    projector.reset(0, entries());
    const { nodes, responses } = projector.snapshot();
    const props = { nodes, responses, workers, processSettled: true };
    await render(props);
    const beta = summaryButton('worker-beta-call');
    await render({ ...props, workers: workers.map((worker) => worker.id === 'worker-alpha' ? { ...worker, status: 'waiting' } : worker) });
    expect(summaryIds()).toEqual(['worker-beta-call']);
    expect(summaryButton('worker-beta-call')).toBe(beta);
    for (const status of ['waiting', 'interrupted', 'stopping'] as const) {
      await render({ ...props, workers: workers.map((worker) => ({ ...worker, status })) });
      expect(summaryIds()).toEqual([]);
      expect(group('process')!.textContent).toBe('用时 7秒');
    }
    await render(props);
    expect(summaryIds()).toEqual(['worker-alpha-call', 'worker-beta-call']);
    await render({ ...props, workers: [] });
    expect(summaryIds()).toEqual([]);
    expect(group('process')!.textContent).toBe('用时 7秒');
  });

  it.each([300, 3500])('opens the chosen worker without expanding or scrolling the process at scrollTop %s', async (scrollTop) => {
    await renderEntries(entries(), { workers, processSettled: true, scrollAffordance: true });
    const viewport = container.querySelector<HTMLElement>('.nodrag')!;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 4000 },
      clientHeight: { configurable: true, value: 500 },
    });
    await act(async () => {
      viewport.scrollTop = scrollTop;
      viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    });
    const summary = summaryButton('worker-beta-call')!;
    expect(summary.type).toBe('button');
    expect(summary.tabIndex).toBe(0);
    summary.focus();
    await click(summary);
    expect(openWorker).toHaveBeenCalledExactlyOnceWith('worker-beta');
    expect(toggle('process')!.getAttribute('aria-expanded')).toBe('false');
    expect(summaryIds()).toEqual(['worker-alpha-call', 'worker-beta-call']);
    expect(group('process')!.querySelector('[data-node-id]')).toBeNull();
    expect(container.textContent).not.toContain('Review complete');
    expect(dom.window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(summary);
    expect(viewport.scrollTop).toBe(scrollTop);

    await click(toggle('process'));
    expect(toggle('process')!.getAttribute('aria-expanded')).toBe('true');
    expect(summaryIds()).toEqual([]);
    expect(originalButton('worker-complete-call')).not.toBeNull();
    await click(originalButton('worker-beta-call'));
    expect(openWorker.mock.calls).toEqual([['worker-beta'], ['worker-beta']]);
    expect(toggle('process')!.getAttribute('aria-expanded')).toBe('true');
    expect(dom.window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not invent active summaries for missing worker states or old creation results during a later turn', async () => {
    await renderEntries([
      user(0), assistant('sample-history', [
        call('missing-worker-call', 'subagent', { subject: 'Historical sample', type: 'explore' }),
        call('legacy-worker-call', 'subagent', { subject: 'Legacy sample', type: 'local-worker' }),
        call('unreturned-worker-call', 'subagent', { subject: 'Partial sample', type: 'explore' }),
      ]),
      result('missing-worker-call', 'subagentId: worker-unavailable'),
      result('legacy-worker-call', 'Worker created: Legacy sample'),
      assistant('sample-history-final', 'Historical reply'),
      { ...user(9000), id: 'next-sample-user' },
    ], { workers, toolsActive: true });
    expect(toggle('process')!.textContent).toBe('执行过程');
    expect(summaryIds()).toEqual([]);
    expect(group('process')!.querySelector('[data-live]')).toBeNull();
    expect(group('process')!.querySelector(`.${activeTextStyles.text}`)).toBeNull();
  });
});

describe('resuming a settled process', () => {
  const initialEntries = (): ConversationEntry[] => [
    user(), assistant('sample-work', [
      call('sample-old-tool'),
      call('sample-worker-call', 'subagent', { subject: 'Sample work', type: 'local-worker' }),
    ]), result('sample-old-tool'), result('sample-worker-call', 'subagentId: sample-worker'),
  ];
  const notification = (id = 'sample-notification', type = 'message'): MsgEntry => ({
    t: 'msg', role: 'user', subtype: 'subagent_notification', id, ts: 9000,
    content: `<subagent_event id="sample-worker" type="${type}">Sample worker update</subagent_event>`,
  });
  const activeWorkers: readonly WorkerRef[] = defaultWorkers.map((worker) => ({ ...worker, status: 'running' }));

  it.each([false, true])('retains the same process through wakeup, tools and final commit (manually open: %s)', async (open) => {
    const { session, append, stream, finish, show } = await start(initialEntries());
    stream('sample-first-request', 'First reply');
    await show({ workers: activeWorkers });
    expect(group('process')).toBeNull();
    finish('sample-first-request');
    await show({ processSettled: true, workers: activeWorkers });
    expect(group('process')).toBeNull();
    append(assistant('sample-first-final', 'First reply', 8000), 'sample-first-request');
    await show({ processSettled: true, workers: activeWorkers });
    const process = group('process')!;
    const header = toggle('process')!;
    expect(header.textContent).toBe('用时 7秒');
    expect(process.dataset.groupId).toBe('process:sample-user');
    if (open) await click(header);
    const expectRetained = () => {
      expect(group('process')).toBe(process);
      expect(toggle('process')).toBe(header);
      expect(header.textContent).toBe('用时 7秒');
      expect(header.getAttribute('aria-expanded')).toBe(String(open));
      expect(container.querySelectorAll('[data-transcript-group="process"]')).toHaveLength(1);
      expect(process.querySelector('[data-worker-summary="sample-worker-call"]') !== null).toBe(!open);
    };

    // Status can change before the notification is projected.
    await show({ toolsActive: true, activeStartedAt: 9000, workers: activeWorkers });
    expectRetained();
    append(notification());
    await show({ toolsActive: true, workers: activeWorkers });
    expectRetained();
    expect(outsideIds()).toEqual(['sample-user', 'sample-first-final', 'sample-notification']);
    stream('sample-tool-request', 'Reviewing the update', 'think');
    await show({ toolsActive: true, workers: activeWorkers });
    expectRetained();
    expect(outsideIds().at(-1)).toBe('live:sample-agent:sample-tool-request:0');
    stream('sample-tool-request', 'Further inspection', 'text', 2);
    await show({ toolsActive: true, workers: activeWorkers });
    expectRetained();
    expect(outsideIds().slice(-2)).toEqual([
      'live:sample-agent:sample-tool-request:0', 'live:sample-agent:sample-tool-request:1',
    ]);
    finish('sample-tool-request');
    append(assistant('sample-followup', [
      { type: 'thinking', thinking: 'Reviewing the update' },
      { type: 'text', text: 'Further inspection' },
      call('sample-next-shell'), call('sample-next-read', 'read', { file_path: '/tmp/example.txt' }),
    ], 12000), 'sample-tool-request');
    append(result('sample-next-shell'));
    append(result('sample-next-read', '1\tExample text'));
    await show({ processSettled: true, workers: activeWorkers });
    expectRetained();
    expect(outsideIds()).toEqual([
      'sample-user', 'sample-first-final', 'sample-notification', 'sample-followup-think-0', 'sample-followup-text',
    ]);
    const tools = toggle('tools')!;
    expect(tools.querySelector('svg.lucide-file-text')).not.toBeNull();
    expect(tools.textContent).toContain('/tmp/example.txt');
    await show({ toolsActive: true, workers: activeWorkers });
    expect(tools.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
    stream('sample-final-request', 'Latest reply');
    await show({ toolsActive: true, workers: activeWorkers });
    expectRetained();
    expect(tools.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(outsideIds().at(-1)).toBe('live:sample-agent:sample-final-request:0');
    expect(node('sample-first-final')!.compareDocumentPosition(node('sample-notification')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(node('sample-notification')!.compareDocumentPosition(group('tools')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group('tools')!.compareDocumentPosition(node('live:sample-agent:sample-final-request:0')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    finish('sample-final-request');
    await show({ processSettled: true, workers: activeWorkers });
    expectRetained();
    append(assistant('sample-latest-final', [
      { type: 'text', text: 'Latest reply' }, { type: 'text', text: 'Additional final paragraph' },
    ], 20000), 'sample-final-request');
    await show({ workers: activeWorkers });
    expectRetained();
    await show({ processSettled: true, activeStartedAt: 9000, workers: activeWorkers });
    expectRetained();
    await show({ processSettled: true, workers: activeWorkers });
    expect(group('process')).toBe(process);
    expect(toggle('process')).toBe(header);
    expect(header.getAttribute('aria-expanded')).toBe(String(open));
    expect(header.textContent).toBe('用时 19秒');
    expect(container.querySelectorAll('[data-transcript-group="process"]')).toHaveLength(1);
    expect(outsideIds()).toEqual(['sample-user', 'sample-latest-final-text', 'sample-latest-final-text-1']);
    if (open) {
      expect(process.contains(node('sample-first-final'))).toBe(true);
      expect(process.contains(node('sample-notification'))).toBe(true);
    } else {
      expect(node('sample-first-final')).toBeNull();
      expect(node('sample-notification')).toBeNull();
      await click(process.querySelector('[data-worker-summary="sample-worker-call"] button'));
      expect(openWorker).toHaveBeenCalledExactlyOnceWith('sample-worker');
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(dom.window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
      expect(node('sample-worker-call')).toBeNull();
      expect(node('sample-first-final')).toBeNull();
      expect(node('sample-notification')).toBeNull();
      await click(header);
      expect(header.getAttribute('aria-expanded')).toBe('true');
      expect(process.contains(node('sample-first-final'))).toBe(true);
      await click(header);
    }
    await show({ processSettled: true, workers: defaultWorkers });
    expect(container.querySelector('[data-worker-summary]')).toBeNull();
    expect(group('process')).toBe(process);
    session.close();
  });

  it.each([
    { hasWork: true, open: false },
    { hasWork: true, open: true },
    { hasWork: false, open: false },
  ])('folds unfinished continuation at new input after a normal reply (preceding work: $hasWork, manually open: $open)', async ({ hasWork, open }) => {
    const { session, append, show } = await start([
      ...(hasWork ? initialEntries() : [user()]), assistant('sample-first-final', 'First reply', 8000),
    ]);
    await show({ processSettled: true, workers: activeWorkers });
    const previousProcess = group('process');
    const previousHeader = toggle('process');
    if (open) await click(previousHeader);
    await show({ toolsActive: true, activeStartedAt: 9000, workers: activeWorkers });
    append(notification());
    await show({ toolsActive: true, workers: activeWorkers });
    expect(group('process')).toBe(previousProcess);
    expect(outsideIds()).toEqual(['sample-user', 'sample-first-final', 'sample-notification']);

    append(assistant('sample-resumed-work', [
      { type: 'thinking', thinking: 'Review the sample update.' },
      { type: 'text', text: 'Inspecting the update.' },
      call('sample-resumed-first'), call('sample-resumed-last'),
      ...(!hasWork ? [call('sample-worker-call', 'subagent', { subject: 'Sample work', type: 'local-worker' })] : []),
    ], 10000));
    await show({ toolsActive: true, workers: activeWorkers });
    expect(group('process')).toBe(previousProcess);
    expect(node('sample-resumed-work-text')).not.toBeNull();
    await click(toggle('tools'));
    append({ ...result('sample-resumed-first'), ts: 11000 });
    append({ ...result('sample-resumed-last'), ts: 11000 });
    if (!hasWork) append({ ...result('sample-worker-call', 'subagentId: sample-worker'), ts: 11000 });
    await show({ toolsActive: true, workers: activeWorkers });
    const workerMarkup = container.querySelector<HTMLButtonElement>(
      '[data-worker-summary="sample-worker-call"] button, [data-node-id="sample-worker-call"] button',
    )!.outerHTML;
    // The user input is consumed after the tool batch; the resumed activity has no normal final reply.
    append({ ...user(15000), id: 'sample-next-user', content: 'Inspect another example.' });
    await show({ toolsActive: true, workers: activeWorkers });
    const process = group('process')!;
    const header = toggle('process')!;
    expect(container.querySelectorAll('[data-transcript-group="process"]')).toHaveLength(1);
    expect(process.dataset.groupId).toBe('process:sample-user');
    if (hasWork) {
      expect(process).toBe(previousProcess);
      expect(header).toBe(previousHeader);
    }
    expect(header.textContent).toBe('执行过程');
    expect(header.getAttribute('aria-expanded')).toBe(String(open));
    expect(outsideIds()).toEqual(['sample-user', 'sample-next-user']);
    if (!open) {
      expect(node('sample-first-final')).toBeNull();
      expect(node('sample-resumed-work-text')).toBeNull();
      const summary = process.querySelector<HTMLButtonElement>('[data-worker-summary="sample-worker-call"] button')!;
      expect(summary.outerHTML).toBe(workerMarkup);
      expect(summary.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
      await click(summary);
      expect(openWorker).toHaveBeenCalledExactlyOnceWith('sample-worker');
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(dom.window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
      await click(header);
    }
    expect(toggle('tools')!.getAttribute('aria-expanded')).toBe('true');
    for (const id of ['sample-first-final', 'sample-notification', 'sample-resumed-work-think-0', 'sample-resumed-work-text', 'sample-resumed-first', 'sample-resumed-last']) {
      expect(process.contains(node(id))).toBe(true);
    }
    expect(process.contains(node('sample-next-user'))).toBe(false);
    append(assistant('sample-next-final', 'Independent answer.', 18000));
    await show({ processSettled: true, workers: activeWorkers });
    expect(group('process')).toBe(process);
    expect(header.textContent).toBe('执行过程');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(outsideIds()).toEqual(['sample-user', 'sample-next-user', 'sample-next-final']);
    session.close();
  });

  it('keeps the earlier reply outside when a later canonical response contains only a hidden tool', async () => {
    const { session, append, show } = await start([
      ...initialEntries(), assistant('sample-first-final', 'First reply', 8000),
    ]);
    await show({ processSettled: true });
    const header = toggle('process');
    append(notification());
    append(assistant('sample-hidden', [call('sample-task', 'task', { action: 'update' })], 10000));
    append(result('sample-task'));
    await show({ processSettled: true });
    expect(toggle('process')).toBe(header);
    expect(header!.textContent).toBe('用时 7秒');
    expect(outsideIds()).toEqual(['sample-user', 'sample-first-final', 'sample-notification']);
    session.close();
  });

  it.each(['shell', 'plan', 'worker'] as const)('keeps a new %s decision visible after the retained boundary', async (kind) => {
    const { session, append, show } = await start([
      ...initialEntries(), assistant('sample-first-final', 'First reply', 8000),
    ]);
    await show({ processSettled: true });
    const process = group('process');
    const header = toggle('process');
    if (kind === 'worker') {
      append(notification('sample-decision', 'need_user_action'));
    } else {
      append(notification());
      append(assistant('sample-pending-work', [
        call('sample-extra-tool'),
        call('sample-decision', kind, kind === 'plan'
          ? { action: 'create', taskSummary: 'Sample decision', planDocument: '**Review the sample plan**' }
          : { description: 'Sample decision' }),
      ]));
      append(result('sample-extra-tool'));
      session.setPendingCallId('sample-decision');
    }
    await show({ processSettled: false });
    expect(group('process')).toBe(process);
    expect(toggle('process')).toBe(header);
    expect(header!.textContent).toBe('用时 7秒');
    expect(header!.getAttribute('aria-expanded')).toBe('false');
    expect(node('sample-first-final')).not.toBeNull();
    expect(node('sample-decision')).not.toBeNull();
    expect(process!.contains(node('sample-decision'))).toBe(false);
    if (kind === 'plan') expect(node('sample-decision')!.querySelector('strong')?.textContent).toBe('Review the sample plan');
    if (kind !== 'worker') expect(toggle('tools')!.getAttribute('aria-expanded')).toBe('false');
    session.close();
  });

  it('retains the boundary on cancellation, then folds unfinished continuation only when new user input arrives', async () => {
    const { session, append, stream, finish, show } = await start([
      ...initialEntries(), assistant('sample-first-final', 'First reply', 8000),
    ]);
    await show({ processSettled: true });
    const header = toggle('process');
    append(notification());
    stream('sample-cancelled-request', 'Interrupted followup');
    await show({ toolsActive: true });
    append(assistant('sample-cancelled-final', 'Interrupted followup', 12000), 'sample-cancelled-request');
    finish('sample-cancelled-request', 'cancelled');
    await show();
    expect(toggle('process')).toBe(header);
    expect(header!.textContent).toBe('用时 7秒');
    expect(outsideIds()).toEqual(['sample-user', 'sample-first-final', 'sample-notification', 'sample-cancelled-final']);
    append({ ...user(15000), id: 'sample-next-user', content: 'Inspect another example.' });
    append(assistant('sample-next-work', [call('sample-next-tool')]));
    await show({ toolsActive: true });
    expect(toggle('process')).toBe(header);
    expect(header!.textContent).toBe('执行过程');
    expect(outsideIds()).toEqual(['sample-user', 'sample-next-user', 'sample-next-tool']);
    append(result('sample-next-tool'));
    append(assistant('sample-next-final', 'Independent reply', 19000));
    await show({ processSettled: true });
    const processes = [...container.querySelectorAll<HTMLElement>('[data-transcript-group="process"]')];
    expect(processes.map((element) => element.dataset.groupId)).toEqual(['process:sample-user', 'process:sample-next-user']);
    expect(processes.map((element) => element.querySelector('button')!.textContent)).toEqual(['执行过程', '用时 4秒']);
    expect(outsideIds()).toEqual(['sample-user', 'sample-next-user', 'sample-next-final']);
    await click(header);
    expect(group('process')!.contains(node('sample-first-final'))).toBe(true);
    expect(group('process')!.contains(node('sample-cancelled-final'))).toBe(true);
    session.close();
  });
});

describe('user input during execution', () => {
  const nextUser = (): MsgEntry => ({ ...user(15000), id: 'sample-next-user', content: 'Inspect another example.' });
  const activeWorkers: readonly WorkerRef[] = defaultWorkers.map((worker) => ({ ...worker, status: 'running' }));

  it('folds unfinished work at the new input, keeps worker navigation, and finishes the new segment independently', async () => {
    const { session, append, stream, finish, show } = await start([
      user(), assistant('sample-work', [
        { type: 'thinking', thinking: 'Review the first sample.' },
        { type: 'text', text: 'Inspecting the first sample.' },
        call('sample-first-tool'), call('sample-second-tool'),
        call('sample-worker-call', 'subagent', { subject: 'Sample work', type: 'local-worker' }),
      ]), result('sample-first-tool'), result('sample-second-tool'),
      result('sample-worker-call', 'subagentId: sample-worker'),
    ]);
    await show({ toolsActive: true, workers: activeWorkers });
    await click(toggle('tools'));
    const workerMarkup = node('sample-worker-call')!.querySelector('button')!.outerHTML;
    expect(group('process')).toBeNull();

    append(nextUser());
    await show({ toolsActive: true, workers: activeWorkers });
    const process = group('process')!;
    const header = toggle('process')!;
    expect(header.textContent).toBe('执行过程');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(outsideIds()).toEqual(['sample-user', 'sample-next-user']);
    expect(container.textContent).not.toContain('Inspecting the first sample.');
    const summary = process.querySelector<HTMLButtonElement>('[data-worker-summary="sample-worker-call"] button')!;
    expect(summary.outerHTML).toBe(workerMarkup);
    expect(summary.querySelector('[data-orb-variant="expanding"]')).not.toBeNull();
    expect(summary.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
    expect(header.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(process.compareDocumentPosition(node('sample-next-user')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(summary);
    expect(openWorker).toHaveBeenCalledExactlyOnceWith('sample-worker');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(dom.window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

    stream('sample-next-request', 'Review the new input.', 'think');
    stream('sample-next-request', 'Inspecting the next sample.', 'text', 2);
    await show({ toolsActive: true, workers: activeWorkers });
    expect(outsideIds()).toEqual([
      'sample-user', 'sample-next-user', 'live:sample-agent:sample-next-request:0', 'live:sample-agent:sample-next-request:1',
    ]);
    finish('sample-next-request');
    append(assistant('sample-next-work', [
      { type: 'thinking', thinking: 'Review the new input.' },
      { type: 'text', text: 'Inspecting the next sample.' },
      call('sample-next-tool'),
    ], 16000), 'sample-next-request');
    await show({ toolsActive: true, workers: activeWorkers });
    expect(outsideIds()).toEqual([
      'sample-user', 'sample-next-user', 'sample-next-work-think-0', 'sample-next-work-text', 'sample-next-tool',
    ]);
    expect(toggle('process')).toBe(header);
    await click(header);
    expect(toggle('tools')!.getAttribute('aria-expanded')).toBe('true');
    expect(process.contains(node('sample-first-tool'))).toBe(true);
    expect(process.contains(node('sample-next-tool'))).toBe(false);

    append({ ...result('sample-next-tool'), ts: 17000 });
    stream('sample-final-request', 'Latest answer.');
    await show({ toolsActive: true, workers: activeWorkers });
    finish('sample-final-request');
    await show({ processSettled: true, workers: activeWorkers });
    expect(container.querySelectorAll('[data-transcript-group="process"]')).toHaveLength(1);
    append(assistant('sample-next-final', 'Latest answer.', 20000), 'sample-final-request');
    await show({ processSettled: true, workers: activeWorkers });
    const processes = [...container.querySelectorAll<HTMLElement>('[data-transcript-group="process"]')];
    expect(processes.map((element) => element.dataset.groupId)).toEqual(['process:sample-user', 'process:sample-next-user']);
    expect(processes.map((element) => element.querySelector('button')!.textContent)).toEqual(['执行过程', '用时 5秒']);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(processes[1]!.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
    expect(outsideIds()).toEqual(['sample-user', 'sample-next-user', 'sample-next-final']);
    expect(process.contains(node('sample-next-user'))).toBe(false);
    await click(header);
    expect(process.querySelector('[data-worker-summary="sample-worker-call"]')).not.toBeNull();
    await show({ processSettled: true, workers: defaultWorkers });
    expect(process.querySelector('[data-worker-summary]')).toBeNull();
    expect(header.textContent).toBe('执行过程');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    session.close();
  });

  it.each([false, true])('folds after streaming commits and tool settlement precede the queued input (batched render: %s)', async (batched) => {
    const { session, append, stream, finish, show } = await start([user()]);
    stream('sample-running-request', 'Checking the sample.', 'think');
    stream('sample-running-request', 'Still working.', 'text', 2);
    await show({ toolsActive: true });
    expect(group('process')).toBeNull();
    expect(outsideIds()).toEqual([
      'sample-user', 'live:sample-agent:sample-running-request:0', 'live:sample-agent:sample-running-request:1',
    ]);
    // Queued input is consumed at the next model boundary, after canonical response and tool results.
    finish('sample-running-request');
    await show({ toolsActive: true });
    expect(group('process')).toBeNull();
    append(assistant('sample-running-work', [
      { type: 'thinking', thinking: 'Checking the sample.' }, { type: 'text', text: 'Still working.' },
      call('sample-running-tool'),
    ], 8000), 'sample-running-request');
    if (!batched) {
      await show({ toolsActive: true });
      expect(node('sample-running-tool')).not.toBeNull();
      expect(group('process')).toBeNull();
    }
    append({ ...result('sample-running-tool'), ts: 9000 });
    if (!batched) await show({ toolsActive: true });
    append(nextUser());
    await show({ toolsActive: true });
    expect(toggle('process')!.textContent).toBe('执行过程');
    expect(toggle('process')!.getAttribute('aria-expanded')).toBe('false');
    expect(outsideIds()).toEqual(['sample-user', 'sample-next-user']);
    await click(toggle('process'));
    expect([...group('process')!.querySelectorAll<HTMLElement>('[data-node-id]')].map((element) => element.dataset.nodeId))
      .toEqual(['sample-running-work-think-0', 'sample-running-work-text', 'sample-running-tool']);
    expect(group('process')!.querySelector('[data-live]')).toBeNull();
    session.close();
  });

  it.each([false, true])('preserves the last normal answer when running is published before the new input (preceding work: %s)', async (hasWork) => {
    const { session, append, show } = await start([
      user(), ...(hasWork ? [assistant('sample-work', [call('sample-tool')]), result('sample-tool')] : []),
      assistant('sample-final', 'Completed answer.', 8000),
    ]);
    await show({ processSettled: true });
    const process = group('process');
    if (hasWork) await click(toggle('process'));
    await show({ toolsActive: true, activeStartedAt: 14000 });
    expect(node('sample-final')).not.toBeNull();
    expect(group('process')).toBe(process);
    append(nextUser());
    await show({ toolsActive: true, activeStartedAt: 14000 });
    expect(group('process')).toBe(process);
    expect(outsideIds()).toEqual(['sample-user', 'sample-final', 'sample-next-user']);
    if (hasWork) {
      expect(toggle('process')!.textContent).toBe('用时 7秒');
      expect(toggle('process')!.getAttribute('aria-expanded')).toBe('true');
    }
    session.close();
  });

  it.each([
    { subtype: 'system_event', content: '<agent_input source="system">Sample system update.</agent_input>' },
    { subtype: 'subagent_notification', content: '<subagent_event id="sample-worker" type="message">Sample worker update.</subagent_event>' },
  ] as const)('does not treat $subtype as a new user input', async ({ subtype, content }) => {
    const { session, append, show } = await start([
      user(), assistant('sample-work', [{ type: 'text', text: 'Still inspecting.' }, call('sample-tool')]), result('sample-tool'),
    ]);
    await show({ toolsActive: true });
    append({ t: 'msg', role: 'user', id: 'sample-notice', ts: 9000, subtype, content });
    await show({ toolsActive: true });
    expect(group('process')).toBeNull();
    expect(outsideIds()).toEqual(['sample-user', 'sample-work-text', 'sample-tool', 'sample-notice']);
    append(assistant('sample-final', 'Completed answer.', 20000));
    await show({ processSettled: true });
    expect(group('process')!.dataset.groupId).toBe('process:sample-user');
    expect(outsideIds()).toEqual(['sample-user', 'sample-final']);
    session.close();
  });
});

describe('transcript disclosures', () => {
  it('groups a growing single call and preserves manual expansion when more calls arrive', async () => {
    const entries: ConversationEntry[] = [
      user(), assistant('sample-start', [{ type: 'text', text: 'Inspecting.' }, call('call-one', 'shell', { description: 'First action' })]),
    ];
    await renderEntries(entries, { toolsActive: true });
    expect(toggle('tools')).toBeNull();
    expect(container.querySelector('[data-node-id="call-one"]')).not.toBeNull();
    expect(container.textContent).toContain('First action');

    entries.push(result('call-one'), assistant('sample-next', [call('call-two', 'shell', { description: 'Second action' })]));
    await renderEntries(entries, { toolsActive: true });
    const summary = toggle('tools')!;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
    expect(group('tools')!.dataset.groupId).toBe('tools:call-one');
    expect(container.querySelector('[data-node-id="call-one"]')).toBeNull();
    expect(summary.textContent).toContain('Second action');
    await click(summary);
    expect(container.querySelector('[data-node-id="call-one"]')).not.toBeNull();
    entries.push(assistant('sample-more', [call('call-three', 'shell', { description: 'Third action' })]));
    await renderEntries(entries, { toolsActive: true });
    expect(toggle('tools')).toBe(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-node-id="call-three"]')).not.toBeNull();
    expect(summary.textContent).toContain('Third action');
    await click([...container.querySelectorAll<HTMLButtonElement>('[data-node-id="call-three"] button')]
      .find((button) => button.textContent === '转入后台')!);
    expect(onAction).toHaveBeenCalled();
  });

  it('follows the latest tool type and text while keeping the same unrotated icon when expanded', async () => {
    const entries: ConversationEntry[] = [
      user(), assistant('sample-start', [
        call('sample-first', 'shell'), call('sample-shell', 'shell', { description: 'Inspect sample' }),
      ]),
    ];
    await renderEntries(entries, { toolsActive: true });
    const summary = toggle('tools')!;
    expect(summary.querySelector('svg')?.classList.contains('lucide-terminal')).toBe(true);
    expect(summary.textContent).toContain('Inspect sample');

    entries.push(result('sample-first'), result('sample-shell'), assistant('sample-next', [
      call('sample-read', 'read', { file_path: '/tmp/example.txt' }),
    ]));
    await renderEntries(entries, { toolsActive: true });
    expect(toggle('tools')).toBe(summary);
    expect(summary.querySelector('svg')?.classList.contains('lucide-file-text')).toBe(true);
    expect(summary.textContent).toContain('/tmp/example.txt');
    expect(summary.textContent).not.toContain('Inspect sample');
    expect(summary.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
    const readIcon = summary.querySelector('svg')!.outerHTML;
    expect(summary.type).toBe('button');
    expect(summary.tabIndex).toBe(0);
    summary.focus();
    expect(document.activeElement).toBe(summary);
    await click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(summary.querySelector('svg')!.outerHTML).toBe(readIcon);
    expect(summary.querySelector(`.${styles.groupCaret}`)).toBeNull();
    expect(summary.querySelectorAll('svg')).toHaveLength(1);

    entries.push(result('sample-read', '1\tSample text'));
    await renderEntries(entries, { toolsActive: true });
    expect(container.querySelector('[data-node-id="sample-read"] button svg')!.outerHTML).toBe(readIcon);
    entries.push(assistant('sample-plan-response', [call('sample-plan', 'plan', {
      action: 'create', taskSummary: 'Review sample', planDocument: 'Sample steps',
    })]));
    await renderEntries(entries, { toolsActive: true });
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(summary.querySelector('svg')?.classList.contains('lucide-file-diff')).toBe(true);
    expect(summary.textContent).toContain('Review sample');
    const planIcon = summary.querySelector('svg')!;
    expect(container.querySelector('[data-node-id="sample-plan"] button svg')?.innerHTML).toBe(planIcon.innerHTML);
    expect(summary.querySelector(`.${styles.groupCaret}`)).toBeNull();
    await click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.querySelector('svg')).toBe(planIcon);
    expect(container.querySelector('[data-node-id="sample-read"]')).toBeNull();
  });

  it('retains the process caret and disclosure controls around tool type summaries', async () => {
    await renderEntries([
      user(), assistant('sample-tools', [call('sample-first'), call('sample-last')]),
      result('sample-first'), result('sample-last'), assistant('sample-final', 'Sample answer', 8000),
    ], { processSettled: true });
    const process = toggle('process')!;
    const caret = process.querySelector('svg')!;
    expect(caret.classList.contains('lucide-chevron-right')).toBe(true);
    expect(caret.classList.contains(styles.groupCaret!)).toBe(true);
    expect(process.type).toBe('button');
    expect(process.tabIndex).toBe(0);
    expect(process.getAttribute('aria-expanded')).toBe('false');
    expect(toggle('tools')).toBeNull();
    await click(process);
    expect(process.getAttribute('aria-expanded')).toBe('true');
    expect(process.querySelector('svg')).toBe(caret);
    expect(toggle('tools')?.querySelector('svg')?.classList.contains('lucide-terminal')).toBe(true);
    await click(toggle('tools'));
    expect(toggle('tools')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-node-id="sample-last"]')).not.toBeNull();
    await click(process);
    expect(process.getAttribute('aria-expanded')).toBe('false');
    expect(toggle('tools')).toBeNull();
  });

  it('keeps worker cards between groups, isolates their activity, and restores order inside a finished process', async () => {
    const entries: ConversationEntry[] = [
      user(), assistant('sample-first', [
        { type: 'text', text: 'Inspecting.' }, call('call-one'), call('call-two'),
        call('sample-worker-call', 'subagent', { subject: 'Sample work', type: 'local-worker' }),
      ]), result('call-one'), result('call-two'),
    ];
    await renderEntries(entries, { toolsActive: true });
    const first = toggle('tools')!;
    expect(first.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(container.querySelector('[data-node-id="sample-worker-call"]')).not.toBeNull();
    // The worker card keeps its own existing creation animation.
    expect(container.querySelector(`[data-node-id="sample-worker-call"] .${activeTextStyles.text}`)).not.toBeNull();
    entries.push(
      result('sample-worker-call', 'subagentId: sample-worker'),
      assistant('sample-next', [call('call-three'), call('call-four')]),
      result('call-three'), result('call-four'),
    );
    await renderEntries(entries, { toolsActive: true });
    const summaries = [...container.querySelectorAll<HTMLButtonElement>('[data-transcript-group="tools"] > button')];
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toBe(first);
    expect(first.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(summaries[1]!.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
    await click(summaries[0]!);
    await click(summaries[1]!);
    const orderedIds = ['call-one', 'call-two', 'sample-worker-call', 'call-three', 'call-four'];
    const visibleCalls = () => [...container.querySelectorAll<HTMLElement>('[data-node-id]')]
      .map((element) => element.dataset.nodeId).filter((id) => orderedIds.includes(id!));
    expect(visibleCalls()).toEqual(orderedIds);
    await click(first);
    expect(visibleCalls()).toEqual(orderedIds.slice(2));
    await click(first);
    expect(visibleCalls()).toEqual(orderedIds);

    entries.push(assistant('sample-final', 'Final answer', 8000));
    await renderEntries(entries, { processSettled: true });
    expect(toggle('process')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-node-id="sample-worker-call"]')).toBeNull();
    await click(toggle('process'));
    expect(visibleCalls()).toEqual(orderedIds);
    expect(group('process')!.querySelector('[data-node-id="sample-worker-call"]')).not.toBeNull();
    expect([...container.querySelectorAll('[data-transcript-group="tools"] > button')]
      .every((button) => button.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect(group('process')!.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    await click(container.querySelector('[data-node-id="sample-worker-call"] button'));
    expect(openWorker).toHaveBeenCalledWith('sample-worker');
  });

  it('keeps the thinking shimmer after tool results until the first live text and through its commit', async () => {
    const entries: ConversationEntry[] = [
      user(), assistant('sample-tools', [call('call-one'), call('call-two')]),
    ];
    await renderEntries(entries, { toolsActive: true });
    const summary = toggle('tools')!;
    expect(summary.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
    entries.push(result('call-one'), result('call-two'));
    await renderEntries(entries, { toolsActive: true });
    expect(summary.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();

    const projector = new TranscriptProjector();
    projector.reset(0, entries);
    const { nodes, responses } = projector.snapshot();
    const live = (kind: 'text' | 'think') => projectLiveNodes('sample-agent', {
      phase: 'streaming', requestId: 'sample-request', runId: 'sample-run', attempt: 1, lastSequence: 1,
      parts: [{ kind, markdown: kind === 'text' ? 'F' : 'Reviewing the results' }],
    });
    await render({ nodes: [...nodes, ...live('think')], responses, toolsActive: true });
    expect(toggle('tools')).toBe(summary);
    expect(summary.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
    await click(summary);
    await render({ nodes: [...nodes, ...live('text')], responses, toolsActive: true });
    expect(summary.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    entries.push(assistant('sample-final', 'Final answer'));
    await renderEntries(entries, { toolsActive: true });
    expect(toggle('tools')).toBe(summary);
    expect(summary.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(summary.getAttribute('aria-expanded')).toBe('true');
  });

  it('stops the shimmer when activity ends or pauses without needing more text', async () => {
    const entries = [
      user(), assistant('sample-tools', [call('call-one'), call('call-two')]),
      result('call-one'), result('call-two'),
    ];
    await renderEntries(entries, { toolsActive: true });
    const summary = toggle('tools')!;
    expect(summary.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
    await renderEntries(entries, { toolsActive: false });
    expect(summary.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    await renderEntries(entries, { toolsActive: false, processSettled: true });
    expect(summary.querySelector(`.${activeTextStyles.text}`)).toBeNull();
  });

  it('keeps pending approval visible without the group shimmer', async () => {
    await renderEntries([
      user(), assistant('sample-plan-response', [
        call('sample-shell'), call('sample-plan', 'plan', {
          action: 'create', taskSummary: 'Sample plan', planDocument: '**Review this plan**',
        }),
      ]), result('sample-shell'),
    ], { toolsActive: false }, 'sample-plan');
    expect(toggle('tools')?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle('tools')?.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('Review this plan');
  });

  it('animates only the current interval, not older intervals with subsequent text', async () => {
    await renderEntries([
      user(), assistant('sample-first', [call('call-one'), call('call-two')]),
      assistant('sample-next', [
        { type: 'text', text: 'Checking another sample.' }, call('call-three'), call('call-four'),
      ]), result('call-three'), result('call-four'),
    ], { toolsActive: true });
    const summaries = [...container.querySelectorAll('[data-transcript-group="tools"] > button')];
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(summaries[1]!.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
  });

  it.each([false, true])('does not relight earlier user work during a new turn (final reply: %s)', async (hasFinal) => {
    const entries: ConversationEntry[] = [
      user(), assistant('sample-earlier-tools', [call('call-one'), call('call-two')]),
      result('call-one'), result('call-two'),
      ...(hasFinal ? [assistant('sample-earlier-final', 'Earlier answer')] : []),
      { ...user(5000), id: 'sample-next-user' },
    ];
    await renderEntries(entries, { toolsActive: true });
    if (hasFinal) await click(toggle('process'));
    expect(toggle('tools')).not.toBeNull();
    expect(toggle('tools')!.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    entries.push(assistant('sample-current-tools', [call('call-three'), call('call-four')]));
    await renderEntries(entries, { toolsActive: true });
    const summaries = [...container.querySelectorAll('[data-transcript-group="tools"] > button')];
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(summaries[1]!.querySelector(`.${activeTextStyles.text}`)).not.toBeNull();
  });

  it('waits for the complete final response and normal idle state, then preserves nested interval expansion', async () => {
    const entries = [user(), assistant('sample-preface', 'Inspecting.'), assistant('sample-tools', [call('sample-shell'), call('sample-read', 'read', { file_path: '/tmp/sample.txt' })]), result('sample-shell'), result('sample-read', '1\tSample file')];
    const session = createTranscriptSession('sample-agent', {
      conversation: async () => ({ from: 0, total: entries.length, entries }),
    });
    await session.start();
    const show = async (processSettled = false) => {
      const snapshot = session.state.getState();
      await render({
        nodes: [...snapshot.projection.nodes, ...projectLiveNodes('sample-agent', snapshot.live)],
        responses: snapshot.projection.responses, processSettled,
      });
    };
    await show();
    await click(toggle('tools'));
    const intervalId = group('tools')!.dataset.groupId;
    session.applyLive({ agentId: 'sample-agent', requestId: 'sample-request', runId: 'sample-run', attempt: 1, sequence: 1, kind: 'text', delta: '**Final' }, 'sample-request');
    await show();
    expect(group('process')).toBeNull();
    session.applyLive({ agentId: 'sample-agent', requestId: 'sample-request', runId: 'sample-run', attempt: 1, sequence: 2, kind: 'text', delta: ' reply**' }, 'sample-request');
    await show();
    expect(group('tools')!.dataset.groupId).toBe(intervalId);
    expect(toggle('tools')!.getAttribute('aria-expanded')).toBe('true');
    session.setRequestState({ requestId: 'sample-request', phase: 'finished', outcome: 'success', attempt: 1, maxAttempts: 1 });
    await show(true);
    expect(group('process')).toBeNull();
    session.append({ agentId: 'sample-agent', index: entries.length, requestId: 'sample-request', entry: assistant('sample-final', [{ type: 'text', text: '**Final reply**\n\n```js\nconst sample = 1;\n```' }], 78000) });
    await show();
    expect(group('process')).toBeNull();
    await show(true);
    expect(toggle('process')?.textContent).toBe('用时 1分17秒');
    expect(toggle('process')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Inspecting.');
    expect(container.querySelector('strong')?.textContent).toBe('Final reply');
    expect(container.querySelector('pre')?.textContent).toContain('const sample = 1;');
    await click(toggle('process'));
    expect(toggle('tools')!.getAttribute('aria-expanded')).toBe('true');
    expect(group('process')?.querySelector('strong')).toBeNull();
    await click(container.querySelector('[data-node-id="sample-read"] button'));
    expect(openFile).toHaveBeenCalledWith('sample-read');
    await click(toggle('process'));
    await click(toggle('process'));
    expect(toggle('tools')!.getAttribute('aria-expanded')).toBe('true');
    session.close();
  });

  it('shows single calls directly across text, keeping tool details and worker navigation', async () => {
    await renderEntries([
      user(), assistant('sample-response', [call('sample-shell', 'shell'), { type: 'text', text: 'A later explanation.' }, call('sample-worker-call', 'subagent', { subject: 'Sample work', type: 'local-worker' })]),
      result('sample-shell', 'Sample command output'), result('sample-worker-call', 'subagentId: sample-worker'),
    ]);
    expect(group('tools')).toBeNull();
    await click(container.querySelector('[data-node-id="sample-shell"] button'));
    expect(container.textContent).toContain('Sample command output');
    await click(container.querySelector('[data-node-id="sample-worker-call"] button'));
    expect(openWorker).toHaveBeenCalledWith('sample-worker');
  });

  it('shows a single pending plan directly and does not fold pending work', async () => {
    await renderEntries([
      user(), assistant('sample-preface', 'Preparing a plan.'),
      assistant('sample-plan-response', [call('sample-plan', 'plan', { action: 'create', taskSummary: 'Sample plan', planDocument: '**Review this plan**' })]),
    ], { processSettled: true, responses: undefined }, 'sample-plan');
    expect(group('tools')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('Review this plan');
    expect(group('process')).toBeNull();
  });

  it('opens partial history as a generic process when complete response metadata is unavailable', async () => {
    const projector = new TranscriptProjector();
    projector.reset(5, [result('sample-history-call', 'Sample historical output')], [{
      index: 2,
      entry: assistant('sample-history-work', [
        { type: 'text', text: 'Inspecting the historical sample.' }, call('sample-history-call'),
      ]),
    }]);
    const { nodes } = projector.snapshot();
    await render({ nodes, processSettled: true });
    expect(toggle('process')?.textContent).toBe('执行过程');
    expect(toggle('process')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Inspecting the historical sample.');
    await act(async () => i18n.changeLanguage('en-US'));
    expect(toggle('process')?.textContent).toBe('Execution process');
    await click(toggle('process'));
    expect(group('process')?.textContent).toContain('Inspecting the historical sample.');
    expect(group('tools')).toBeNull();
    await click(container.querySelector('[data-node-id="sample-history-call"] button'));
    expect(group('process')?.textContent).toContain('Sample historical output');
    expect([...container.querySelectorAll('[data-node-id]')].every((node) => group('process')!.contains(node)))
      .toBe(true);
  });

  it('localizes summaries without inventing a duration for incomplete history timestamps', async () => {
    const entries = [user(0), assistant('sample-preface', 'Inspecting.'), assistant('sample-final', 'Final reply')];
    await renderEntries(entries, { processSettled: true });
    expect(toggle('process')?.textContent).toBe('执行过程');
    await act(async () => i18n.changeLanguage('en-US'));
    expect(toggle('process')?.textContent).toBe('Execution process');
    await click(toggle('process'));
    expect(container.textContent).toContain('Inspecting.');
    await renderEntries([user(), ...entries.slice(1, -1), assistant('sample-final', 'Final reply', 6000)], { processSettled: true });
    expect(toggle('process')?.textContent).toBe('Took 5s');
  });

  it('follows height changes at the bottom without forcing a reader back down on completion', async () => {
    const entries = [user(), assistant('sample-preface', 'Inspecting.')];
    await renderEntries(entries, { scrollAffordance: true });
    const viewport = container.querySelector<HTMLElement>('.nodrag')!;
    let height = 2000;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 500 },
    });
    await renderEntries([...entries, assistant('sample-progress', 'Checking.')], { scrollAffordance: true });
    expect(viewport.scrollTop).toBe(2000);
    await act(async () => {
      viewport.scrollTop = 200;
      viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    });
    height = 1000;
    await renderEntries([...entries, assistant('sample-final', 'Final reply', 6000)], { processSettled: true, scrollAffordance: true });
    expect(viewport.scrollTop).toBe(200);
    expect(container.querySelector('button[aria-label="回到底部"]')).not.toBeNull();
  });
});
