import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTarget } from '../../../../../../shared/types/agent-control';
import { EMPTY_EMBEDDED_BROWSER_STATE, type EmbeddedBrowserState } from '../../../../../../shared/types/embedded-browser';
import { ThreadMode, type ThreadModeProps } from '../ThreadMode';
import { FileChangeSummary } from '../../../content/FileChangeSummary';
import { dispatchKeyEvent } from '../../../data/keyboard';
import type { ThreadViewProps } from '../ThreadView';
import type { FilePreviewDescriptor } from '@shared/electron-contracts/desktop';
import type { ReviewSlotProps } from '../../../content/ReviewSlot';
import { deferred } from '../../../attachments/__tests__/fixtures';
import { BrowserScreenView, type BrowserScreenViewProps } from '../../../content/ScreenView';

const vm = vi.hoisted(() => ({
  workers: [
    { id: 'worker-one', subject: 'Worker one', type: 'browser-worker', status: 'waiting', browserId: 'automation-one', browserReady: true },
    { id: 'worker-two', subject: 'Worker two', type: 'browser-worker', status: 'waiting', browserId: 'automation-two', browserReady: false },
  ],
  emptyWorkers: [],
  listeners: new Set<() => void>(),
}));
vi.mock('../../../data/vm', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    vm.listeners.add(listener);
    return () => { vm.listeners.delete(listener); };
  };
  const useWorkers = () => useSyncExternalStore(subscribe, () => vm.workers);
  return {
    useAgentVM: (agentId: string) => {
      const workers = useWorkers();
      return {
        agentId, title: agentId, status: 'waiting', workers: agentId === 'session-alpha' ? workers : vm.emptyWorkers,
      };
    },
    useWorkerVM: (_agentId: string, workerId?: string) => useWorkers().find((worker) => worker.id === workerId) ?? null,
  };
});
vi.mock('../../../data/useWorkerActivity', () => ({ useWorkerActivity: () => ({ text: 'Sample current action', unfinished: true }) }));
vi.mock('../../../data/actions', () => ({ useConsoleActions: () => ({}) }));
vi.mock('../../../data/useImageNodes', () => ({ useImageNodes: () => [] }));
vi.mock('../../../content/ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../../../content/ReviewSlot', () => ({ ReviewSlot: (props: ReviewSlotProps) => {
  reviewInstances.push(props);
  const { target, onUpdateTarget } = props;
  return createElement('div', {
    'data-review-kind': target?.kind,
    'data-review-path': target?.kind === 'path' ? target.path : undefined,
    'data-preview-kind': target?.kind === 'path' ? target.preview.kind : undefined,
    'data-preview-revision': target?.kind === 'path' ? target.preview.revision : undefined,
  }, target?.kind === 'path' && createElement('button', { onClick: () => onUpdateTarget?.(target, {
    ...target, preview: { ...target.preview, revision: 'revision-two' },
  }) }, 'Refresh sample snapshot'));
} }));
vi.mock('../ThreadView', () => ({ ThreadView: ({ onToggleFileChanges, fileChangesOpen, onOpenFileChange, readingAreaRef }: ThreadViewProps) => createElement('div', { ref: readingAreaRef },
  createElement(FileChangeSummary, { changes: { filesChanged: 1, added: 1, removed: 0 }, expanded: fileChangesOpen, onToggle: onToggleFileChanges }),
  createElement('button', { onClick: () => onOpenFileChange?.('sample-call') }, 'Open sample call'),
) }));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../../content/ScreenView', () => ({
  BrowserScreenView: vi.fn(({ browserId, browserReady, fidelity, interactive, controls }: BrowserScreenViewProps) => createElement('div', {
    'data-screen': controls === false ? undefined : browserId,
    'data-monitor-screen': controls === false ? browserId : undefined,
    'data-ready': String(browserReady), 'data-fidelity': fidelity,
    'data-interactive': String(interactive),
  }, browserReady ? null : '等待浏览器启动…')),
}));
vi.mock('@/components/content-links', () => ({
  ContentLinkUrlScope: ({ children, onOpenUrl, onOpenLocalFile }: {
    children: ReactNode; onOpenUrl: (url: string) => void; onOpenLocalFile: (path: string) => void;
  }) => (
    createElement('div', null,
      createElement('button', { onClick: () => onOpenUrl('https://example.test/page') }, 'Open preview link'),
      createElement('button', { onClick: () => onOpenLocalFile('/workspace/.示例目录') }, 'Open sample directory'),
      children,
    )
  ),
}));

const keyOf = (target: AgentTarget) => JSON.stringify([target.agentId, target.workerId ?? null]);
const states = new Map<string, EmbeddedBrowserState>();
const subscriptions = new Map<string, Set<(state: EmbeddedBrowserState) => void>>();
const retiredListeners: Array<(state: EmbeddedBrowserState) => void> = [];
function publish(target: AgentTarget, state: EmbeddedBrowserState) {
  states.set(keyOf(target), state);
  for (const listener of subscriptions.get(keyOf(target)) ?? []) listener(state);
}
const api = {
  open: vi.fn(async (target: AgentTarget) => {
    publish(target, states.get(keyOf(target))?.open
      ? states.get(keyOf(target))!
      : { ...EMPTY_EMBEDDED_BROWSER_STATE, open: true });
  }),
  close: vi.fn(async (target: AgentTarget) => publish(target, EMPTY_EMBEDDED_BROWSER_STATE)),
  navigate: vi.fn(async (target: AgentTarget, url: string) => {
    publish(target, { ...EMPTY_EMBEDDED_BROWSER_STATE, open: true, url });
  }),
  openLocalHtml: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn(), stop: vi.fn(),
  setBounds: vi.fn(), setVisible: vi.fn(),
  observeState: (target: AgentTarget, listener: (state: EmbeddedBrowserState) => void) => {
    const key = keyOf(target);
    const listeners = subscriptions.get(key) ?? new Set();
    listeners.add(listener);
    subscriptions.set(key, listeners);
    listener(states.get(key) ?? EMPTY_EMBEDDED_BROWSER_STATE);
    return () => { listeners.delete(listener); retiredListeners.push(listener); };
  },
};

const preview = vi.fn<(path: string) => Promise<FilePreviewDescriptor>>();
const reviewInstances: ReviewSlotProps[] = [];
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.assign(dom.window, { piskie: { pilot: { embeddedBrowser: api }, desktop: { files: { preview } } } });
});
beforeEach(() => {
  vi.clearAllMocks();
  vm.workers = [
    { id: 'worker-one', subject: 'Worker one', type: 'browser-worker', status: 'waiting', browserId: 'automation-one', browserReady: true },
    { id: 'worker-two', subject: 'Worker two', type: 'browser-worker', status: 'waiting', browserId: 'automation-two', browserReady: false },
  ];
  vm.listeners.clear();
  preview.mockReset().mockResolvedValue({ kind: 'directory', revision: 'revision-one' });
  reviewInstances.length = 0;
  states.clear();
  subscriptions.clear();
  retiredListeners.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

async function render(agentId = 'session-alpha') {
  const props: ThreadModeProps = {
    sessions: [], history: [], selectedAgentId: agentId,
    onSelectSession: vi.fn(), onSelectHistory: vi.fn(),
    menuSourceOf: () => ({ phase: 'waiting' }),
    sessionsCollapsed: true, onToggleSessions: vi.fn(), emptyState: null,
  };
  await act(async () => root.render(createElement(ThreadMode, props)));
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((element) => (
    element.getAttribute('aria-label') === label || element.textContent === label
  ));
  expect(found, `button: ${label}`).toBeDefined();
  return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
const address = () => container.querySelector<HTMLInputElement>('input');
const visibleScreen = () => container.querySelector<HTMLElement>('[data-screen][data-fidelity="visible"]');
async function removeBrowsers() {
  await act(async () => {
    vm.workers = [];
    for (const listener of vm.listeners) listener();
  });
}
function frameCallback(fps: number) {
  const props = vi.mocked(BrowserScreenView).mock.calls.findLast(([props]) => (
    props.browserId === 'automation-one' && props.controls === false && props.fps === fps
  ))?.[0];
  expect(props?.onFrameChange).toBeDefined();
  return props!.onFrameChange!;
}
async function updateBrowserReady(workerId: string, browserReady: boolean) {
  await act(async () => {
    vm.workers = vm.workers.map((worker) => worker.id === workerId ? { ...worker, browserReady } : worker);
    for (const listener of vm.listeners) listener();
  });
}

describe('thread screen readiness', () => {
  it('selects a newly allocated Worker without a screen shell, then opens its screen on the ready update', async () => {
    await render();
    await click('Worker two');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Worker two');
    expect(button('展开右侧栏').getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-panel-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('[data-screen]')).toBeNull();
    expect(vi.mocked(BrowserScreenView).mock.calls.some(([props]) => props.controls !== false)).toBe(false);
    expect(container.querySelector('[data-screen]')?.textContent).toBeUndefined();

    await updateBrowserReady('worker-two', true);

    expect(button('收起右侧栏').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-panel-hidden="true"]')).toBeNull();
    expect(visibleScreen()?.dataset.screen).toBe('automation-two');
    expect(visibleScreen()?.dataset.ready).toBe('true');
    expect(visibleScreen()?.dataset.interactive).toBe('true');
    expect(api.open).not.toHaveBeenCalled();
    expect(api.navigate).not.toHaveBeenCalled();
  });

  it('switches between ready and unready Workers without changing navigation', async () => {
    await render();
    await click('Worker one');
    expect(visibleScreen()?.dataset.screen).toBe('automation-one');
    await click('Worker two');
    expect(container.querySelector('[data-screen]')).toBeNull();
    expect(button('展开右侧栏').getAttribute('aria-expanded')).toBe('false');
    await click('Worker one');
    expect(visibleScreen()?.dataset.screen).toBe('automation-one');
    await click('session-alpha');
    expect(container.querySelector('[data-screen]')).toBeNull();
  });

  it.each(['closed', 'collapsed'] as const)('preserves a %s screen across readiness changes until the user restores it', async (state) => {
    await render();
    await click('Worker one');
    await click(state === 'closed' ? '关闭屏幕' : '收起右侧栏');
    await updateBrowserReady('worker-one', false);
    await updateBrowserReady('worker-one', true);
    expect(container.querySelector('[data-screen]')).toBeNull();
    expect(button('展开右侧栏').getAttribute('aria-expanded')).toBe('false');

    await click('展开右侧栏');
    expect(visibleScreen()?.dataset.screen).toBe('automation-one');
    expect(api.open).not.toHaveBeenCalled();
  });

  it.each(['browser', 'review'] as const)('retains the user-selected %s panel when the screen becomes available', async (panel) => {
    await render();
    await click('Worker two');
    await click(panel === 'browser' ? 'Open preview link' : 'Open sample directory');
    const label = panel === 'browser' ? '浏览器' : '审阅';
    const selected = () => button(label).closest('[data-selected="true"]');
    expect(selected()).not.toBeNull();
    expect(container.querySelector('[data-screen]')).toBeNull();

    await updateBrowserReady('worker-two', true);
    expect(selected()).not.toBeNull();
    expect(button('屏幕')).toBeDefined();
    await click('屏幕');
    expect(visibleScreen()?.dataset.screen).toBe('automation-two');
    await click(label);
    await updateBrowserReady('worker-two', false);
    expect(container.querySelector('button[aria-label="关闭屏幕"]')).toBeNull();
    await updateBrowserReady('worker-two', true);
    expect(selected()).not.toBeNull();
    if (panel === 'browser') expect(address()?.value).toBe('https://example.test/page');
    else expect(container.querySelector('[data-review-kind]')?.getAttribute('data-review-kind')).toBe('path');
  });

  it('unmounts an unready cached screen while another ready Worker stays visible', async () => {
    await updateBrowserReady('worker-two', true);
    await render();
    await click('Worker one');
    await click('Worker two');
    expect(container.querySelector('[data-screen="automation-one"]')?.getAttribute('data-fidelity')).toBe('hidden');

    await updateBrowserReady('worker-one', false);
    expect(container.querySelector('[data-screen="automation-one"]')).toBeNull();
    expect(visibleScreen()?.dataset.screen).toBe('automation-two');
    expect(visibleScreen()?.textContent).not.toContain('等待浏览器启动');
    await updateBrowserReady('worker-one', true);
    expect(container.querySelector('[data-screen="automation-one"]')?.getAttribute('data-fidelity')).toBe('hidden');
    expect(visibleScreen()?.dataset.screen).toBe('automation-two');
  });
});

describe('main browser monitoring', () => {
  it('shows allocated browser tasks together, including an accurate unready placeholder', async () => {
    await render();
    expect(button('监控').closest('[data-selected="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-monitor-task]')).toHaveLength(2);
    expect(container.querySelector('[data-monitor-task="worker-two|automation-two"]')?.textContent).toContain('等待浏览器启动');
    for (const [props] of vi.mocked(BrowserScreenView).mock.calls.filter(([props]) => props.controls === false)) {
      expect(props.fit).toBe('full');
      expect(props.fps).toBe(4);
      expect(props.interactive).not.toBe(true);
    }
  });
  it('keeps terminal tasks during the browser grace period and keeps placeholders when readiness is lost', async () => {
    await render();
    await click('打开Worker one的预览');
    await act(async () => {
      vm.workers = vm.workers.map((worker) => ({ ...worker,
        taskState: { inputAt: 1, notification: { type: 'completed', at: 2 } },
      }));
      for (const listener of vm.listeners) listener();
    });
    expect(container.querySelectorAll('[data-monitor-task]')).toHaveLength(2);
    expect(container.querySelector('[data-monitor-window]')).not.toBeNull();
    await updateBrowserReady('worker-one', false);
    expect(container.querySelectorAll('[data-monitor-task]')).toHaveLength(2);
    expect(container.querySelector('[data-monitor-window]')?.textContent).toContain('等待浏览器启动');
    await removeBrowsers();
    expect(container.querySelector('[data-monitor-task]')).toBeNull();
    expect(container.querySelector('[data-monitor-window]')).toBeNull();
  });
  it('keeps live monitors available when their pictures are lost', async () => {
    await render();
    const panelFrame = frameCallback(4);
    await act(async () => panelFrame(true));
    await click('打开Worker one的预览');
    const floatingFrame = frameCallback(30);
    await act(async () => { floatingFrame(true); panelFrame(false); floatingFrame(false); });
    expect(container.querySelectorAll('[data-monitor-task]')).toHaveLength(2);
    expect(container.querySelector('[data-monitor-window]')).not.toBeNull();
    expect(button('监控')).toBeDefined();
  });
  it.each(['review', 'browser', 'collapsed', 'closed'] as const)('retains the %s choice when a new browser joins the collection', async (choice) => {
    await render();
    if (choice === 'review') await click('Open sample directory');
    if (choice === 'browser') await click('Open preview link');
    if (choice === 'collapsed') await click('收起右侧栏');
    if (choice === 'closed') await click('关闭监控');
    await act(async () => {
      vm.workers = [...vm.workers, { id: 'worker-three', subject: 'Worker three', type: 'browser-worker', status: 'running', browserId: 'automation-three', browserReady: false }];
      for (const listener of vm.listeners) listener();
    });
    if (choice === 'review' || choice === 'browser') expect(button(choice === 'review' ? '审阅' : '浏览器').closest('[data-selected="true"]')).not.toBeNull();
    else expect(button('展开右侧栏').getAttribute('aria-expanded')).toBe('false');
  });
  it.each(['review', 'browser', 'collapsed', 'closed'] as const)('returns a floating preview to the shared monitor from %s', async (choice) => {
    await render();
    await click('打开Worker one的预览');
    expect(container.querySelector('[data-monitor-window="worker-one|automation-one"]')).not.toBeNull();
    if (choice === 'review') await click('Open sample directory');
    if (choice === 'browser') await click('Open preview link');
    if (choice === 'collapsed') await click('收起右侧栏');
    if (choice === 'closed') await click('关闭监控');
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    try {
      await click('回监控栏');
      expect(container.querySelector('[data-monitor-window]')).toBeNull();
      expect(button('监控').closest('[data-selected="true"]')).not.toBeNull();
      expect(button('收起右侧栏').getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(input);
      expect(api.close).not.toHaveBeenCalled();
      if (choice === 'review') expect(button('审阅')).toBeDefined();
      if (choice === 'browser') {
        expect(button('浏览器')).toBeDefined();
        expect(api.navigate).toHaveBeenCalledOnce();
      }
    } finally { input.remove(); }
  });
  it('automatically removes an uncaptured floating preview and the empty monitor entry when resources close', async () => {
    await render();
    await click('打开Worker one的预览');
    await removeBrowsers();
    expect(container.querySelector('[data-monitor-window]')).toBeNull();
    expect(container.querySelector('[data-monitor-task]')).toBeNull();
    expect(container.querySelector('button[aria-label="关闭监控"]')).toBeNull();
    expect(button('展开右侧栏').getAttribute('aria-expanded')).toBe('false');
    expect(api.open).not.toHaveBeenCalled();
  });
  it.each(['visible', 'minimized'] as const)('removes captured cards and a %s floating preview after resource closure', async (state) => {
    await render();
    const panelFrame = frameCallback(4);
    await act(async () => panelFrame(true));
    await click('打开Worker one的预览');
    const floatingFrame = frameCallback(30);
    await act(async () => floatingFrame(true));
    if (state === 'minimized') await click('缩小');
    await removeBrowsers();
    await act(async () => { panelFrame(true); floatingFrame(true); });
    expect(container.querySelector('[data-monitor-task]')).toBeNull();
    expect(container.querySelector('[data-monitor-window]')).toBeNull();
    expect(container.querySelector('[data-monitor-parking]')).toBeNull();
    expect(container.querySelector('button[aria-label="关闭监控"]')).toBeNull();
    expect(button('展开右侧栏').getAttribute('aria-expanded')).toBe('false');
  });
  it('removes only the departed resource while the remaining unready browser and review stay available', async () => {
    await render();
    const panelFrame = frameCallback(4);
    await act(async () => panelFrame(true));
    await click('打开Worker one的预览');
    await click('打开Worker two的预览');
    const remaining = container.querySelector('[data-monitor-task="worker-two|automation-two"]');
    await click('Open sample directory');
    await act(async () => {
      vm.workers = vm.workers.filter((worker) => worker.id !== 'worker-one');
      for (const listener of vm.listeners) listener();
    });
    await act(async () => panelFrame(true));
    expect(container.querySelector('[data-monitor-task="worker-one|automation-one"]')).toBeNull();
    expect(container.querySelector('[data-monitor-window="worker-one|automation-one"]')).toBeNull();
    expect(container.querySelector('[data-monitor-task="worker-two|automation-two"]')).toBe(remaining);
    expect(container.querySelectorAll('[data-monitor-window]')).toHaveLength(1);
    expect(button('审阅').closest('[data-selected="true"]')).not.toBeNull();
    await click('回监控栏');
    expect(button('监控').closest('[data-selected="true"]')).not.toBeNull();
    expect(remaining?.textContent).toContain('等待浏览器启动');
  });
  it('discards departed canvas facts and ignores queued callbacks even after returning to the same conversation', async () => {
    await render();
    const oldPanelFrame = frameCallback(4);
    await act(async () => oldPanelFrame(true));
    await click('打开Worker one的预览');
    const oldFloatingFrame = frameCallback(30);
    await act(async () => oldFloatingFrame(true));
    await render('session-beta');
    expect(container.querySelector('[data-monitor-window]')).toBeNull();
    await removeBrowsers();
    await act(async () => { oldPanelFrame(true); oldFloatingFrame(true); });
    await render();
    await act(async () => { oldPanelFrame(true); oldFloatingFrame(true); });
    expect(container.querySelector('button[aria-label="关闭监控"]')).toBeNull();
    expect(button('展开右侧栏').getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-monitor-task="worker-one|automation-one"]')).toBeNull();
  });
  it('keeps restored window parking per conversation and lets only the new preview own its frame', async () => {
    await render();
    const oldFrame = frameCallback(4);
    await act(async () => oldFrame(true));
    await click('打开Worker one的预览');
    await click('缩小');
    await render('session-beta');
    expect(container.querySelector('[data-monitor-parking]')).toBeNull();
    await render();
    expect(container.querySelector('[data-monitor-parking]')).not.toBeNull();
    expect(container.querySelector('[data-monitor-window]')?.hasAttribute('hidden')).toBe(true);
    await act(async () => frameCallback(4)(true));
    await act(async () => oldFrame(false));
    await removeBrowsers();
    expect(container.querySelector('button[aria-label="关闭监控"]')).toBeNull();
    expect(container.querySelector('[data-monitor-task]')).toBeNull();
    expect(container.querySelector('[data-monitor-parking]')).toBeNull();
    await render('session-beta');
    await render();
    expect(container.querySelector('[data-monitor-window]')).toBeNull();
    expect(container.querySelector('[data-monitor-parking]')).toBeNull();
  });
  it('replaces a browser on the same worker and clears the previous floating and parked preview', async () => {
    await render();
    const previousFrame = frameCallback(4);
    await act(async () => previousFrame(true));
    await click('打开Worker one的预览');
    await click('缩小');
    await act(async () => {
      vm.workers = vm.workers.map((worker) => worker.id === 'worker-one'
        ? { ...worker, browserId: 'automation-next', browserReady: false } : worker);
      for (const listener of vm.listeners) listener();
    });
    await act(async () => previousFrame(true));
    expect(container.querySelector('[data-monitor-task="worker-one|automation-one"]')).toBeNull();
    expect(container.querySelector('[data-monitor-task="worker-one|automation-next"]')?.textContent).toContain('等待浏览器启动');
    expect(container.querySelectorAll('[data-monitor-task]')).toHaveLength(2);
    expect(container.querySelector('[data-monitor-window]')).toBeNull();
    expect(container.querySelector('[data-monitor-parking]')).toBeNull();
    await click('打开Worker one的预览');
    expect(container.querySelector('[data-monitor-window="worker-one|automation-next"]')).not.toBeNull();
    await removeBrowsers();
    expect(container.querySelector('[data-monitor-window]')).toBeNull();
  });
});

describe('thread preview controls', () => {
  it('retains refreshed descriptors across panel and conversation switches and rejects callbacks from another scope', async () => {
    await render();
    await click('Open sample directory');
    await click('Refresh sample snapshot');
    const latest = reviewInstances.at(-1)!;
    expect(container.querySelector('[data-preview-revision]')?.getAttribute('data-preview-revision')).toBe('revision-two');
    await click('Open preview link');
    await click('审阅');
    expect(container.querySelector('[data-preview-revision]')?.getAttribute('data-preview-revision')).toBe('revision-two');
    await render('session-beta');
    await act(async () => latest.onUpdateTarget!(latest.target as Extract<NonNullable<ReviewSlotProps['target']>, { kind: 'path' }>, null));
    await render();
    expect(container.querySelector('[data-preview-revision]')?.getAttribute('data-preview-revision')).toBe('revision-two');
    expect(preview).toHaveBeenCalledOnce();
  });

  it('rejects an obsolete callback after closing and reopening the same path', async () => {
    await render();
    await click('Open sample directory');
    const previous = reviewInstances.at(-1)!;
    await click('关闭审阅');
    await click('Open sample directory');
    await act(async () => previous.onUpdateTarget!(previous.target as Extract<NonNullable<ReviewSlotProps['target']>, { kind: 'path' }>, null));
    expect(container.querySelector('[data-preview-revision]')?.getAttribute('data-preview-revision')).toBe('revision-one');
  });

  it.each(['scope', 'selection', 'close', 'unmount'] as const)('discards an initial preview that finishes after %s changes', async (action) => {
    await render();
    await click('Open sample directory');
    const pending = deferred<FilePreviewDescriptor>();
    preview.mockReturnValueOnce(pending.promise);
    await click('Open sample directory');
    if (action === 'scope') await render('session-beta');
    else if (action === 'selection') await click('Open sample call');
    else if (action === 'close') await click('关闭审阅');
    else await act(async () => root.render(null));
    await act(async () => pending.resolve({ kind: 'directory', revision: 'revision-two' }));
    expect(container.querySelector('[data-preview-revision="revision-two"]')).toBeNull();
    if (action === 'selection') expect(container.querySelector('[data-review-kind]')?.getAttribute('data-review-kind')).toBe('cell');
  });


  it('opens the right review panel for a directory through the shared path entry', async () => {
    await render();
    expect(container.querySelector('[data-review-kind]')).toBeNull();
    await click('Open sample directory');
    expect(preview).toHaveBeenCalledExactlyOnceWith('/workspace/.示例目录');
    const review = container.querySelector('[data-review-kind]')!;
    expect(review.getAttribute('data-review-kind')).toBe('path');
    expect(review.getAttribute('data-review-path')).toBe('/workspace/.示例目录');
    expect(review.getAttribute('data-preview-kind')).toBe('directory');
    expect(button('收起右侧栏').getAttribute('aria-expanded')).toBe('true');
  });

  it('synchronizes the collection toggle with closing, Escape, other review targets and browser selection', async () => {
    await render();
    const summary = () => container.querySelector<HTMLButtonElement>('button[aria-label*="个文件已更改"]')!;
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    await act(async () => summary().click());
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-review-kind]')?.getAttribute('data-review-kind')).toBe('collection');
    await click('Open sample call');
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-review-kind]')?.getAttribute('data-review-kind')).toBe('cell');
    await act(async () => summary().click());
    await act(async () => { expect(dispatchKeyEvent({ key: 'Escape' })).toBe(true); });
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-review-kind]')).toBeNull();
    await act(async () => summary().click());
    await click('Open preview link');
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    await act(async () => summary().click());
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(address()).toBeNull();
    await act(async () => summary().click());
    expect(summary().getAttribute('aria-expanded')).toBe('false');
  });

  it('restores a collapsed preview without navigating and releases it only on close', async () => {
    await render();
    await click('Open preview link');
    expect(address()?.value).toBe('https://example.test/page');
    await click('收起右侧栏');
    expect(address()).toBeNull();
    expect(api.close).not.toHaveBeenCalled();
    await click('展开右侧栏');
    expect(address()?.value).toBe('https://example.test/page');
    expect(api.navigate).toHaveBeenCalledOnce();
    expect(api.open).not.toHaveBeenCalled();
    await click('关闭浏览器');
    expect(api.close).toHaveBeenCalledWith({ agentId: 'session-alpha', workerId: undefined });
    expect(button('监控').closest('[data-selected="true"]')).not.toBeNull();
    expect(api.open).not.toHaveBeenCalled();
    expect(address()).toBeNull();
  });

  it('consumes Escape while cancelling an address edit', async () => {
    await render();
    await click('Open preview link');
    const input = address()!;
    Object.assign(input, { attachEvent: vi.fn(), detachEvent: vi.fn() });
    await act(async () => input.focus());
    const escape = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    await act(async () => input.dispatchEvent(escape));

    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(input);
  });

  it('keeps conversation visibility separate and rejects a retired subscription update', async () => {
    await render();
    await click('Open preview link');
    await click('收起右侧栏');
    await render('session-beta');
    expect(address()).toBeNull();
    await click('展开右侧栏');
    expect(api.open).toHaveBeenLastCalledWith({ agentId: 'session-beta', workerId: undefined });
    await act(async () => retiredListeners[0]!({ ...EMPTY_EMBEDDED_BROWSER_STATE, open: true, url: 'https://example.test/stale' }));
    expect(address()?.value).toBe('');
    await render();
    expect(address()).toBeNull();
    await click('展开右侧栏');
    expect(address()?.value).toBe('https://example.test/page');
    expect(api.navigate).toHaveBeenCalledOnce();
  });

  it('scopes worker previews and restores the same automation screen after closing its tab', async () => {
    await render();
    await click('Open preview link');
    await click('Worker one');
    expect(address()).toBeNull();
    expect(container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('automation-one');
    await click('Open preview link');
    expect(api.navigate).toHaveBeenLastCalledWith(
      { agentId: 'session-alpha', workerId: 'worker-one' }, 'https://example.test/page',
    );
    await click('关闭浏览器');
    expect(container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('automation-one');
    api.close.mockClear();
    await click('关闭屏幕');
    expect(container.querySelector('[data-screen]')).toBeNull();
    expect(api.close).not.toHaveBeenCalled();
    await click('展开右侧栏');
    expect(container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('automation-one');
    expect(api.open).not.toHaveBeenCalled();
    await click('session-alpha');
    expect(address()?.value).toBe('https://example.test/page');
  });

  it('keeps a closed screen tab closed when collapsing and expanding a preview', async () => {
    await render();
    await click('Worker one');
    await click('Open preview link');
    await click('关闭屏幕');
    await click('收起右侧栏');
    await click('展开右侧栏');
    expect(address()?.value).toBe('https://example.test/page');
    expect(container.querySelector('button[aria-label="关闭屏幕"]')).toBeNull();
    expect(api.close).not.toHaveBeenCalled();
  });
});
