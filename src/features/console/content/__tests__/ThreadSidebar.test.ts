import { act, createElement, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { JSDOM } from 'jsdom';
import { createJSONStorage } from 'zustand/middleware';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDefinitionSnapshot } from '../../../../../shared/electron-contracts/task-definitions';
import { useUIStore } from '../../../../store/uiStore';
import { useToastStore } from '../../../toasts/toast-store';
import { composerDraftKey, useComposerDraftStore } from '../../data/composer-drafts';
import type { PopoverProps } from '../../chrome/Popover';
import type { ActionResult } from '../../data/actions';
import type { HistoryRow } from '../../data/sessionRow';
import type { AgentRunAttention } from '@/domains/agent-runs/agent-run-attention';
import { projectActiveAgentRun } from '../../data/agentRunViewModel';
import type { AgentControlSnapshot } from '@shared/electron-contracts/agent-runs';
import { TaskDefinitionLauncher } from '../../shell/TaskDefinitionLauncher';
import { ThreadSidebar, type ThreadSidebarProps } from '../ThreadSidebar';

const historyState = vi.hoisted(() => ({ ready: true }));
const attentionState = vi.hoisted(() => ({
  attentionByAgentId: {} as Record<string, AgentRunAttention>,
  listeners: new Set<() => void>(),
}));
const consoleActions = vi.hoisted(() => ({
  renameAgentRun: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
  markRead: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
  deleteHistory: vi.fn(async (_id: string): Promise<ActionResult> => ({ ok: true })),
  stop: vi.fn(async (_id: string): Promise<ActionResult> => ({ ok: true })),
  openWorkspace: vi.fn(async (_path?: string): Promise<ActionResult> => ({ ok: true })),
}));
vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal('window', { localStorage: storage });
});
vi.mock('../../data/session', () => ({ useHistoryRowsReady: () => historyState.ready }));
vi.mock('@/renderer-runtime/hooks', () => ({
  useAgentRunList: (selector: (state: typeof attentionState) => unknown) => useSyncExternalStore(
    (listener) => { attentionState.listeners.add(listener); return () => { attentionState.listeners.delete(listener); }; },
    () => selector(attentionState),
  ),
}));
vi.mock('../../data/actions', () => ({ useConsoleActions: () => consoleActions }));
vi.mock('../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../chrome/Popover', () => ({
  Popover: ({ trigger, open, children }: PopoverProps) => createElement('div', null, trigger, open ? children : null),
}));

let root: Root;
let dom: JSDOM;
let container: HTMLDivElement;
let props: ThreadSidebarProps;
const defaultLabel = '默认工作区';
function history(agentId: string, workspace?: string, day = 1): HistoryRow {
  return {
    agentId, title: `Sample ${agentId}`, taskDescription: `Sample ${agentId}`,
    agentSpec: 'system-chat', workspace, running: false,
    lastActiveAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`,
  };
}
const button = (label: string) => {
  const result = [...container.querySelectorAll('button')].find((node) => (
    node.textContent === label || node.getAttribute('aria-label') === label
  ));
  expect(result, label).toBeDefined();
  return result!;
};
const groupNames = () => [...container.querySelectorAll('button[aria-expanded]')]
  .filter((node) => node.hasAttribute('draggable')).map((node) => node.textContent);
const rowCount = () => container.querySelectorAll('[role="button"]').length;
const visibleAgentIds = () => [...container.querySelectorAll<HTMLElement>('[data-agent-id]')]
  .map((node) => node.dataset.agentId);
async function render(next: Partial<ThreadSidebarProps> = {}) {
  props = { ...props, ...next };
  await act(async () => root.render(createElement(ThreadSidebar, props)));
}
async function click(label: string) { await act(async () => button(label).click()); }
async function clickMenuItem(label: string) {
  const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((node) => node.textContent === label);
  expect(item, label).toBeDefined();
  await act(async () => item!.click());
}
async function search(value: string) {
  const input = container.querySelector('input')!;
  await act(async () => {
    input.value = value;
    Simulate.change(input);
  });
}
async function drag(source: string, target: string, edge: 'before' | 'after') {
  const sourceButton = button(source);
  const targetGroup = button(target).closest('section')!;
  const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  const event = (name: string) => {
    const result = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperties(result, { dataTransfer: { value: transfer }, clientY: { value: edge === 'before' ? -1 : 1 } });
    return result;
  };
  await act(async () => sourceButton.dispatchEvent(event('dragstart')));
  await act(async () => targetGroup.dispatchEvent(event('dragover')));
  expect(targetGroup.getAttribute('data-drop-edge')).toBe(edge);
  await act(async () => targetGroup.dispatchEvent(event('drop')));
}

async function context(target: Element) {
  await act(async () => target.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 80, clientY: 120 })));
}
async function workspaceMenu(name: string) { await context(button(name).parentElement!); }
function menuItem(label: string): HTMLButtonElement {
  const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')]
    .find((node) => node.textContent?.startsWith(label));
  expect(item, label).toBeDefined();
  return item!;
}
async function choose(label: string) { await act(async () => menuItem(label).click()); }
async function sessionDrag(source: string, target?: string, edge: 'before' | 'after' = 'before') {
  const from = container.querySelector<HTMLElement>(`[data-agent-id="${source}"] [draggable]`)!;
  const transfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '', dropEffect: '' };
  const event = (name: string) => {
    const result = new dom.window.Event(name, { bubbles: true, cancelable: true });
    Object.defineProperties(result, { dataTransfer: { value: transfer }, clientY: { value: edge === 'before' ? -1 : 1 } });
    return result;
  };
  await act(async () => from.dispatchEvent(event('dragstart')));
  if (target) {
    const to = container.querySelector<HTMLElement>(`[data-agent-id="${target}"]`)!;
    await act(async () => to.dispatchEvent(event('dragover')));
    await act(async () => to.dispatchEvent(event('drop')));
  }
  await act(async () => from.dispatchEvent(event('dragend')));
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: vi.fn() });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getAnimations', { value: () => [] });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: vi.fn() },
    detachEvent: { configurable: true, value: vi.fn() },
  });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
      this.querySelector<HTMLElement>('[autofocus]')?.focus();
    },
  });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      if (!this.open) return;
      this.removeAttribute('open');
      this.dispatchEvent(new dom.window.Event('close'));
    },
  });
  useUIStore.persist.setOptions({ storage: createJSONStorage(() => localStorage) });
  localStorage.clear();
  useUIStore.setState({
    expandedWorkspaceGroups: [],
    workspaceGroupOrder: [],
    pinnedAgentRunIds: [],
    hiddenWorkspaceGroupKeys: [],
    workspaceSessionSort: {},
    consoleSelection: null,
  });
  useToastStore.setState({ toasts: [] });
  consoleActions.deleteHistory.mockReset().mockResolvedValue({ ok: true });
  consoleActions.stop.mockReset().mockResolvedValue({ ok: true });
  consoleActions.openWorkspace.mockReset().mockResolvedValue({ ok: true });
  historyState.ready = true;
  attentionState.attentionByAgentId = {};
  consoleActions.markRead.mockClear();
  consoleActions.renameAgentRun.mockReset().mockResolvedValue({ ok: true });
  props = {
    sessions: [], history: [history('alpha', '/sample/alpha', 3), history('beta', '/sample/beta', 2), history('default')],
    selectedAgentId: null, collapsed: false, onToggleCollapsed: vi.fn(),
    onSelectSession: vi.fn(), onSelectHistory: vi.fn(), menuSourceOf: () => ({ phase: 'waiting' }),
    onNewSession: vi.fn(), onNewSessionIn: vi.fn(),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('sidebar context actions and sorting', () => {
  it('opens workspace actions without expansion or navigation, and exposes only usable default-group actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render();
    await workspaceMenu('alpha');
    expect(button('alpha').getAttribute('aria-expanded')).toBe('false');
    expect(button('alpha').parentElement!.querySelector('button[aria-haspopup="menu"]')).toBeNull();
    await choose('复制工作空间路径');
    expect(writeText).toHaveBeenCalledWith('/sample/alpha');
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe('工作空间路径已复制');
    await workspaceMenu('alpha');
    await choose('在文件管理器中打开');
    expect(consoleActions.openWorkspace).toHaveBeenCalledWith('/sample/alpha');
    await workspaceMenu('alpha');
    await choose('在此工作空间新建会话');
    expect(props.onNewSessionIn).toHaveBeenCalledWith('/sample/alpha');
    expect(props.onSelectHistory).not.toHaveBeenCalled();
    await workspaceMenu(defaultLabel);
    const labels = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(labels).not.toContain('从侧栏移除');
    expect(labels).not.toContain('复制工作空间路径');
    expect(labels).not.toContain('在文件管理器中打开');
  });

  it('shares row actions between right click and the existing menu and keeps the clicked target', async () => {
    await render({ history: [history('sample-a', '/sample/alpha'), history('sample-b', '/sample/alpha')] });
    await click('alpha');
    const row = container.querySelector<HTMLElement>('[data-agent-id="sample-b"]')!;
    await act(async () => row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    const labels = [...row.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    await act(async () => row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    await context(row);
    expect([...row.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(labels);
    await choose('置顶');
    expect(useUIStore.getState().pinnedAgentRunIds).toEqual(['sample-b']);
    expect(props.onSelectHistory).not.toHaveBeenCalled();
    expect(useUIStore.getState().consoleSelection).toBeNull();
  });

  it('hides running workspaces through reload, activity and search while keeping the current view and draft', async () => {
    const live = projectActiveAgentRun({ agentId: 'sample-live', phase: 'thinking', children: [],
      runConfig: { name: 'Sample live', workspace: '/sample/alpha' },
    } as unknown as AgentControlSnapshot, 'Example');
    const selection = { kind: 'live' as const, agentId: 'sample-live' };
    useUIStore.setState({ consoleSelection: selection });
    useComposerDraftStore.getState().setDraft(composerDraftKey('sample-live'), 'Unsent example');
    await render({ sessions: [live], selectedAgentId: live.agentId });
    const order = useUIStore.getState().workspaceGroupOrder;
    await workspaceMenu('alpha');
    await choose('从侧栏移除');
    expect(groupNames()).toEqual([defaultLabel, 'beta']);
    expect(container.querySelector('dialog[open]')).toBeNull();
    expect(useUIStore.getState().consoleSelection).toEqual(selection);
    expect(useComposerDraftStore.getState().drafts[composerDraftKey('sample-live')]?.text).toBe('Unsent example');
    expect(consoleActions.stop).not.toHaveBeenCalled();
    expect(consoleActions.deleteHistory).not.toHaveBeenCalled();
    expect(useUIStore.getState().workspaceGroupOrder).toEqual(order);
    const saved = localStorage.getItem('piskie-ui-storage')!;
    await act(async () => root.render(null));
    useUIStore.setState({ hiddenWorkspaceGroupKeys: [] });
    localStorage.setItem('piskie-ui-storage', saved);
    await useUIStore.persist.rehydrate();
    await render({ sessions: [{ ...live, phase: 'waiting' }], history: props.history.map((row) => ({ ...row, lastActiveAt: '2026-09-01T00:00:00Z' })) });
    await search('alpha');
    expect(groupNames()).toEqual([]);
    await search('');
    await render({ collapsed: true });
    expect(container.querySelector('[aria-label="Sample live"]')).toBeNull();
    await render({ collapsed: false });
    const undo = useToastStore.getState().toasts.find((toast) => toast.id === 'sidebar-hidden:/sample/alpha');
    expect(undo?.title).toBe('已从侧栏移除');
    await act(async () => undo!.action!.run());
    expect(groupNames()).toEqual([defaultLabel, 'alpha', 'beta']);
  });

  it('keeps hidden workspace slots through drag and menu moves, restoring the saved position on undo', async () => {
    await render({ history: [history('a', '/sample/alpha', 3), history('b', '/sample/beta', 2), history('c', '/sample/gamma')] });
    await workspaceMenu('beta');
    await choose('从侧栏移除');
    await drag('gamma', 'alpha', 'before');
    expect(useUIStore.getState().workspaceGroupOrder).toEqual(['/sample/gamma', '/sample/beta', '/sample/alpha']);
    await workspaceMenu('alpha');
    await choose('上移');
    expect(useUIStore.getState().workspaceGroupOrder).toEqual(['/sample/alpha', '/sample/beta', '/sample/gamma']);
    await drag('gamma', 'alpha', 'before');
    await act(async () => useToastStore.getState().toasts.find((toast) => toast.id === 'sidebar-hidden:/sample/beta')!.action!.run());
    expect(groupNames()).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('enters manual mode only on successful drop using the complete list and blocks restore while searching', async () => {
    await render({ history: Array.from({ length: 8 }, (_, index) => history(`sample-${index}`, '/sample/alpha', 8 - index)) });
    await click('alpha');
    await sessionDrag('sample-4');
    expect(useUIStore.getState().workspaceSessionSort).toEqual({});
    await sessionDrag('sample-4', 'sample-0');
    expect(useUIStore.getState().workspaceSessionSort['/sample/alpha']).toEqual({
      mode: 'manual', order: ['sample-4', 'sample-0', 'sample-1', 'sample-2', 'sample-3', 'sample-5', 'sample-6', 'sample-7'], revision: 1,
    });
    expect(props.onSelectHistory).not.toHaveBeenCalled();
    const restore = useToastStore.getState().toasts.find((toast) => toast.id === 'sidebar-sort:/sample/alpha')!.action!.run;
    await search('sample');
    expect(useToastStore.getState().toasts.find((toast) => toast.id === 'sidebar-sort:/sample/alpha')).toMatchObject({ action: undefined, detail: '清除筛选后调整顺序' });
    await act(async () => restore());
    expect(useUIStore.getState().workspaceSessionSort['/sample/alpha']?.mode).toBe('manual');
    await workspaceMenu('alpha');
    expect(menuItem('会话排序').disabled).toBe(true);
    expect(menuItem('上移').disabled).toBe(true);
    await act(async () => container.querySelector('[data-workspace-scroll]')!.dispatchEvent(new dom.window.Event('scroll')));
    await context(container.querySelector('[data-agent-id="sample-4"]')!);
    expect(menuItem('下移').disabled).toBe(true);
    expect(container.querySelector<HTMLElement>('[data-agent-id="sample-4"] [draggable]')!.draggable).toBe(false);
    await search('');
    await act(async () => restore());
    expect(visibleAgentIds()).toEqual(['sample-0', 'sample-1', 'sample-2', 'sample-3', 'sample-4']);
    await render({ history: props.history.map((row) => row.agentId === 'sample-7' ? { ...row, lastActiveAt: '2026-09-01T00:00:00Z' } : row) });
    await workspaceMenu('alpha');
    await choose('会话排序');
    await choose('手动排序');
    expect(useUIStore.getState().workspaceSessionSort['/sample/alpha']?.order[0]).toBe('sample-7');
    expect(useUIStore.getState().workspaceSessionSort['/sample/alpha']?.order).toHaveLength(8);
  });

  it('persists manual order, inserts new sessions and pin changes at the partition top, and cleans deleted IDs', async () => {
    await render({ history: [history('sample-a', '/sample/alpha', 3), history('sample-b', '/sample/alpha', 2), history('sample-c', '/sample/alpha')] });
    await click('alpha');
    await sessionDrag('sample-c', 'sample-a');
    const saved = localStorage.getItem('piskie-ui-storage')!;
    await act(async () => root.render(null));
    useUIStore.setState({ workspaceSessionSort: {} });
    localStorage.setItem('piskie-ui-storage', saved);
    await useUIStore.persist.rehydrate();
    await render({ history: props.history.map((row) => row.agentId === 'sample-b' ? { ...row, lastActiveAt: '2026-09-01T00:00:00Z' } : row) });
    expect(visibleAgentIds()).toEqual(['sample-c', 'sample-a', 'sample-b']);
    await render({ history: [...props.history, history('sample-new', '/sample/alpha')] });
    expect(visibleAgentIds()).toEqual(['sample-new', 'sample-c', 'sample-a', 'sample-b']);
    await context(container.querySelector('[data-agent-id="sample-a"]')!);
    await choose('置顶');
    await context(container.querySelector('[data-agent-id="sample-b"]')!);
    await choose('置顶');
    expect(visibleAgentIds()).toEqual(['sample-b', 'sample-a', 'sample-new', 'sample-c']);
    await context(container.querySelector('[data-agent-id="sample-a"]')!);
    await choose('取消置顶');
    expect(visibleAgentIds()).toEqual(['sample-b', 'sample-a', 'sample-new', 'sample-c']);
    await context(container.querySelector('[data-agent-id="sample-c"]')!);
    await choose('上移');
    expect(visibleAgentIds()).toEqual(['sample-b', 'sample-a', 'sample-c', 'sample-new']);
    await render({ history: props.history.filter((row) => row.agentId !== 'sample-c') });
    expect(useUIStore.getState().workspaceSessionSort['/sample/alpha']?.order).toEqual(['sample-b', 'sample-a', 'sample-new']);
  });

  it('restores automatic sorting from a pre-merge toast using the current default workspace key', async () => {
    const workspace = '/sample/default';
    await render({ history: [history('sample-a', workspace, 3), history('sample-b', workspace, 2)] });
    await click('default');
    await sessionDrag('sample-b', 'sample-a');
    const restore = useToastStore.getState().toasts.find((toast) => toast.id === `sidebar-sort:${workspace}`)!.action!.run;
    await render({ defaultWorkspacePath: workspace });
    expect(visibleAgentIds()).toEqual(['sample-b', 'sample-a']);
    await act(async () => restore());
    expect(visibleAgentIds()).toEqual(['sample-a', 'sample-b']);
    expect(useUIStore.getState().workspaceSessionSort).toEqual({ '': { mode: 'auto', order: [], revision: 2 } });
    expect(JSON.parse(localStorage.getItem('piskie-ui-storage')!).state.workspaceSessionSort)
      .toEqual({ '': { mode: 'auto', order: [], revision: 2 } });
  });

  it('keeps a new default-path drag when an older automatic preference survives navigation', async () => {
    const workspace = '/sample/default';
    await render({ defaultWorkspacePath: workspace, history: [history('sample-a', workspace, 3), history('sample-b', workspace, 2)] });
    await workspaceMenu(defaultLabel);
    await choose('会话排序');
    await choose('自动排序');
    await act(async () => root.render(null));
    await render({ defaultWorkspacePath: undefined });
    await click('default');
    await sessionDrag('sample-b', 'sample-a');
    expect(visibleAgentIds()).toEqual(['sample-b', 'sample-a']);
    await render({ defaultWorkspacePath: workspace });
    expect(visibleAgentIds()).toEqual(['sample-b', 'sample-a']);
    expect(useUIStore.getState().workspaceSessionSort).toEqual({
      '': { mode: 'manual', order: ['sample-b', 'sample-a'], revision: 2 },
    });
  });

  it.each([
    { earlier: 'auto', latest: 'manual', latestDefault: false },
    { earlier: 'manual', latest: 'auto', latestDefault: false },
    { earlier: 'manual', latest: 'manual', latestDefault: false },
    { earlier: 'auto', latest: 'manual', latestDefault: true },
    { earlier: 'manual', latest: 'auto', latestDefault: true },
    { earlier: 'manual', latest: 'manual', latestDefault: true },
  ] as const)('preserves the latest $latest choice over $earlier across alias rehydration (default=$latestDefault)', async ({ earlier, latest, latestDefault }) => {
    const workspace = '/sample/default';
    useUIStore.setState({ expandedWorkspaceGroups: ['', workspace] });
    await render({ history: [
      history('sample-path-a', workspace, 4), history('sample-path-b', workspace, 3),
      history('sample-legacy-a', undefined, 2), history('sample-legacy-b'),
    ] });
    const chooseSort = async (defaultGroup: boolean, mode: 'auto' | 'manual') => {
      if (mode === 'manual') {
        const prefix = defaultGroup ? 'sample-legacy' : 'sample-path';
        await sessionDrag(`${prefix}-b`, `${prefix}-a`);
      } else {
        await workspaceMenu(defaultGroup ? defaultLabel : 'default');
        await choose('会话排序');
        await choose('自动排序');
      }
    };
    await chooseSort(!latestDefault, earlier);
    await chooseSort(latestDefault, latest);
    const saved = localStorage.getItem('piskie-ui-storage')!;
    await act(async () => root.render(null));
    useUIStore.setState({ workspaceSessionSort: {} });
    localStorage.setItem('piskie-ui-storage', saved);
    await useUIStore.persist.rehydrate();
    await render({ defaultWorkspacePath: workspace });
    const expected = latest === 'auto'
      ? ['sample-path-a', 'sample-path-b', 'sample-legacy-a', 'sample-legacy-b']
      : latestDefault
        ? ['sample-path-a', 'sample-path-b', 'sample-legacy-b', 'sample-legacy-a']
        : ['sample-legacy-a', 'sample-legacy-b', 'sample-path-b', 'sample-path-a'];
    expect(visibleAgentIds()).toEqual(expected);
    expect(useUIStore.getState().workspaceSessionSort).toEqual({
      '': { mode: latest, order: latest === 'manual' ? expected : [], revision: 2 },
    });
    if (latest === 'manual') {
      const toastKey = latestDefault ? '' : workspace;
      await act(async () => useToastStore.getState().toasts.find((toast) => toast.id === `sidebar-sort:${toastKey}`)!.action!.run());
      expect(useUIStore.getState().workspaceSessionSort).toEqual({ '': { mode: 'auto', order: [], revision: 3 } });
    }
  });

  it('preserves default manual preferences while its path resolves separately from the session inventory', async () => {
    useUIStore.setState({
      expandedWorkspaceGroups: ['', '/sample/default'],
      workspaceSessionSort: { '': { mode: 'manual', order: ['sample-current', 'sample-legacy'] } },
    });
    await render({ history: [history('sample-current', '/sample/default'), history('sample-legacy')] });
    expect(useUIStore.getState().workspaceSessionSort['']?.order).toEqual(['sample-current', 'sample-legacy']);
    await render({ defaultWorkspacePath: '/sample/default' });
    expect(visibleAgentIds()).toEqual(['sample-current', 'sample-legacy']);
  });

  it('keeps a hidden path hidden and carries its sorting preference when it becomes the default group', async () => {
    useUIStore.setState({
      workspaceSessionSort: { '/sample/default': { mode: 'manual', order: ['sample-a', 'sample-b'] } },
    });
    await render({ history: [history('sample-a', '/sample/default'), history('sample-b', '/sample/default', 2)] });
    await workspaceMenu('default');
    await choose('从侧栏移除');
    await render({ defaultWorkspacePath: '/sample/default' });
    expect(groupNames()).toEqual([]);
    expect(useUIStore.getState().workspaceSessionSort['']).toEqual({ mode: 'manual', order: ['sample-a', 'sample-b'] });
    await act(async () => useToastStore.getState().toasts.find((toast) => toast.id === 'sidebar-hidden:/sample/default')!.action!.run());
    await click(defaultLabel);
    expect(visibleAgentIds()).toEqual(['sample-a', 'sample-b']);
  });

  it('rejects dragging across pinned partitions or projects and disables sorting before history is ready', async () => {
    useUIStore.setState({ pinnedAgentRunIds: ['sample-pin'] });
    await render({ history: [history('sample-pin', '/sample/alpha'), history('sample-row', '/sample/alpha'), history('sample-other', '/sample/beta')] });
    await click('alpha');
    await click('beta');
    await sessionDrag('sample-pin');
    const originalOrder = useUIStore.getState().workspaceGroupOrder;
    const transfer = { setData: vi.fn(), effectAllowed: '' };
    const event = new dom.window.Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    await act(async () => button('alpha').dispatchEvent(event));
    await act(async () => button('alpha').dispatchEvent(new dom.window.Event('dragend', { bubbles: true })));
    expect(useUIStore.getState().workspaceGroupOrder).toBe(originalOrder);
    await sessionDrag('sample-row', 'sample-pin');
    await sessionDrag('sample-row', 'sample-other');
    expect(useUIStore.getState().workspaceSessionSort).toEqual({});
    historyState.ready = false;
    await render({ history: [...props.history] });
    await workspaceMenu('alpha');
    expect(menuItem('会话排序').disabled).toBe(true);
    expect(menuItem('会话排序').textContent).toContain('历史记录加载后可调整顺序');
    expect(button('alpha').draggable).toBe(false);
  });

  it('confirms a single history deletion, preserves failed records, and clears its saved order only after success', async () => {
    useUIStore.setState({ workspaceSessionSort: { '/sample/alpha': { mode: 'manual', order: ['sample-a', 'sample-b'] } } });
    await render({ history: [history('sample-a', '/sample/alpha'), history('sample-b', '/sample/alpha')] });
    await click('alpha');
    await context(container.querySelector('[data-agent-id="sample-a"]')!);
    await choose('删除会话…');
    expect(consoleActions.deleteHistory).not.toHaveBeenCalled();
    expect(container.querySelector('dialog[open]')!.textContent).toContain('项目文件夹');
    await click('取消');
    expect(consoleActions.deleteHistory).not.toHaveBeenCalled();
    await context(container.querySelector('[data-agent-id="sample-a"]')!);
    await choose('删除会话…');
    consoleActions.deleteHistory.mockResolvedValueOnce({ ok: false, error: { kind: 'raw', text: 'Example deletion failure' } });
    await click('删除');
    expect(container.querySelector('dialog[open] [role="alert"]')!.textContent).toBe('Example deletion failure');
    expect(useUIStore.getState().workspaceSessionSort['/sample/alpha']?.order).toContain('sample-a');
    await click('删除');
    expect(consoleActions.deleteHistory).toHaveBeenLastCalledWith('sample-a');
    await render({ history: props.history.filter((row) => row.agentId !== 'sample-a') });
    expect(useUIStore.getState().workspaceSessionSort['/sample/alpha']?.order).toEqual(['sample-b']);
    expect(consoleActions.stop).not.toHaveBeenCalled();
  });

  it('requires confirmation for stopping a live row while keeping pause independently available', async () => {
    const live = projectActiveAgentRun({ agentId: 'sample-live', phase: 'thinking', children: [], runConfig: { name: 'Sample live' } } as unknown as AgentControlSnapshot, 'Example');
    await render({ sessions: [live], history: [], menuSourceOf: () => ({ phase: 'thinking', agentId: 'sample-live' }) });
    await click(defaultLabel);
    await context(container.querySelector('[data-agent-id="sample-live"]')!);
    expect(menuItem('暂停')).toBeDefined();
    await choose('停止…');
    expect(consoleActions.stop).not.toHaveBeenCalled();
    await click('停止');
    expect(consoleActions.stop).toHaveBeenCalledWith('sample-live');
  });
});

describe('workspace navigation', () => {
  it.each([false, true])('shows session attention beside the existing running indicator (collapsed=%s)', async (collapsed) => {
    const live = projectActiveAgentRun({
      agentId: 'sample-main', phase: 'thinking', children: [], runConfig: { name: 'Sample session' },
    } as unknown as AgentControlSnapshot, 'Example');
    attentionState.attentionByAgentId = { 'sample-main': { unread: true, unreadActionIds: ['sample-worker-approval'] } };
    await render({ collapsed, sessions: [live], history: [] });
    if (!collapsed) await click(defaultLabel);
    expect(container.querySelector('[data-unread="true"]')).not.toBeNull();
    expect(container.querySelector('[data-orb-variant="expanding"]')).not.toBeNull();
    expect(container.querySelector('[aria-label*="未读"]')).not.toBeNull();

    if (!collapsed) {
      await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-id="sample-main"] button[aria-haspopup="menu"]')!.click());
      await click('标记为已读');
      expect(consoleActions.markRead).toHaveBeenCalledWith('sample-main', -1);
    }
    await act(async () => {
      attentionState.attentionByAgentId = { 'sample-main': { unread: false, unreadActionIds: [] } };
      for (const listener of attentionState.listeners) listener();
    });
    expect(container.querySelector('[data-unread="true"]')).toBeNull();
    expect(container.querySelector('[data-orb-variant="expanding"]')).not.toBeNull();
  });

  it('keeps omitted live and historical workspaces in the default group with the original new-session semantics', async () => {
    const live = projectActiveAgentRun({
      agentId: 'sample-main', phase: 'thinking', children: [],
      runConfig: { name: 'Sample session' }, createdAt: '2026-01-04T00:00:00Z',
    } as unknown as AgentControlSnapshot, 'Example');
    await render({
      sessions: [live],
      history: [history('older'), history('sample-main'), history('project', '/sample/workspace')],
    });

    expect(groupNames()).toEqual([defaultLabel, 'workspace']);
    await click(defaultLabel);
    expect(rowCount()).toBe(2);
    expect(container.querySelector('[data-agent-id="sample-main"][data-live="true"]')).not.toBeNull();
    expect(useUIStore.getState().expandedWorkspaceGroups).toEqual(['']);
    expect(useUIStore.getState().workspaceGroupOrder).toEqual(['', '/sample/workspace']);

    await click('在 默认工作区 新建会话');
    expect(props.onNewSessionIn).toHaveBeenLastCalledWith(undefined);
    await click('在 workspace 新建会话');
    expect(props.onNewSessionIn).toHaveBeenLastCalledWith('/sample/workspace');
  });

  it('merges legacy omitted and explicit default paths while preserving the default group identity', async () => {
    const defaultWorkspacePath = '/sample/runtime/workspace';
    useUIStore.setState({
      expandedWorkspaceGroups: [defaultWorkspacePath],
      workspaceGroupOrder: [defaultWorkspacePath, '', '/sample/project'],
    });
    await render({
      defaultWorkspacePath,
      history: [
        history('legacy'),
        history('current', defaultWorkspacePath),
        history('project', '/sample/project'),
      ],
    });

    expect(groupNames()).toEqual([defaultLabel, 'project']);
    expect(useUIStore.getState().workspaceGroupOrder).toEqual(['', '/sample/project']);
    expect(useUIStore.getState().expandedWorkspaceGroups).toEqual(['']);
    expect(rowCount()).toBe(2);
    await click('在 默认工作区 新建会话');
    expect(props.onNewSessionIn).toHaveBeenLastCalledWith(undefined);
  });

  it('waits for full history before saving the initial order, with all groups closed', async () => {
    historyState.ready = false;
    await render({ history: [history('beta', '/sample/beta')] });
    expect(useUIStore.getState().workspaceGroupOrder).toEqual([]);
    historyState.ready = true;
    await render({ history: [history('alpha', '/sample/alpha', 3), history('beta', '/sample/beta', 2), history('default')] });
    expect(groupNames()).toEqual([defaultLabel, 'alpha', 'beta']);
    expect(rowCount()).toBe(0);
    expect(useUIStore.getState().workspaceGroupOrder).toEqual(['', '/sample/alpha', '/sample/beta']);
  });

  it('remembers dragging the default group and manual expansion across rehydration', async () => {
    await render();
    await drag(defaultLabel, 'beta', 'after');
    await click('alpha');
    expect(groupNames()).toEqual(['alpha', 'beta', defaultLabel]);
    const persisted = localStorage.getItem('piskie-ui-storage')!;
    await act(async () => root.render(null));
    useUIStore.setState({ workspaceGroupOrder: [], expandedWorkspaceGroups: [] });
    localStorage.setItem('piskie-ui-storage', persisted);
    await useUIStore.persist.rehydrate();
    await render({ history: [...props.history].reverse() });
    expect(groupNames()).toEqual(['alpha', 'beta', defaultLabel]);
    expect(button('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(rowCount()).toBe(1);
  });

  it('uses temporary expansion during search without changing persisted order or manual state', async () => {
    await render();
    await click('alpha');
    const order = [...useUIStore.getState().workspaceGroupOrder];
    await search('beta');
    expect(groupNames()).toEqual(['beta']);
    expect(rowCount()).toBe(1);
    expect(button('beta').draggable).toBe(false);
    expect(useUIStore.getState().expandedWorkspaceGroups).toEqual(['/sample/alpha']);
    await search('unknown term');
    expect(container.textContent).toContain('没有匹配的会话或工作区');
    await search('');
    expect(useUIStore.getState().workspaceGroupOrder).toEqual(order);
    expect(button('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(button('beta').getAttribute('aria-expanded')).toBe('false');
  });

  it('shows more and less while keeping a selected older session visible', async () => {
    await render({ history: Array.from({ length: 8 }, (_, i) => history(`row-${i}`, '/sample/alpha', 8 - i)) });
    await click('alpha');
    expect(rowCount()).toBe(5);
    await click('查看更多（还有 3 条）');
    expect(rowCount()).toBe(8);
    await click('收起列表');
    await render({ selectedAgentId: 'row-7' });
    expect(rowCount()).toBe(6);
    expect(container.querySelector('[data-selected="true"]')?.textContent).toContain('Sample row-7');
    await click('查看更多（还有 2 条）');
    await click('收起列表');
    expect(rowCount()).toBe(6);
    await click('alpha');
    await render({ history: props.history.map((row) => ({ ...row, lastActiveAt: '2026-02-01T00:00:00Z' })) });
    expect(rowCount()).toBe(0);
  });

  it('pins and unpins a session without taking a recent preview slot', async () => {
    const rows = Array.from({ length: 6 }, (_, index) => (
      history(`row-${index}`, '/sample/alpha', 6 - index)
    ));
    await render({ history: rows, selectedAgentId: 'row-5' });
    await click('alpha');
    expect(visibleAgentIds()).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5']);

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-agent-id="row-5"] button[aria-haspopup="menu"]',
    )!.click());
    await clickMenuItem('置顶');

    expect(visibleAgentIds()).toEqual(['row-5', 'row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    expect(container.querySelector('[data-agent-id="row-5"]')?.getAttribute('data-pinned')).toBe('true');
    expect(useUIStore.getState().pinnedAgentRunIds).toEqual(['row-5']);
    expect(JSON.parse(localStorage.getItem('piskie-ui-storage')!).state.pinnedAgentRunIds).toEqual(['row-5']);

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-agent-id="row-5"] button[aria-haspopup="menu"]',
    )!.click());
    await clickMenuItem('取消置顶');
    expect(visibleAgentIds()).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
    expect(useUIStore.getState().pinnedAgentRunIds).toEqual([]);

    await render({ selectedAgentId: null });
    expect(visibleAgentIds()).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
  });

  it('keeps five pinned rows visible alongside a new live session and five recent slots', async () => {
    const pinned = Array.from({ length: 5 }, (_, index) => history(`pinned-${index}`, undefined, 12 - index));
    const recent = Array.from({ length: 6 }, (_, index) => history(`recent-${index}`, undefined, 6 - index));
    useUIStore.setState({ pinnedAgentRunIds: pinned.map((row) => row.agentId) });
    const live = projectActiveAgentRun({
      agentId: 'sample-live', phase: 'thinking', children: [], runConfig: { name: 'Sample session' },
    } as unknown as AgentControlSnapshot, 'Example');
    await render({ sessions: [live], history: [...pinned, ...recent] });
    await click(defaultLabel);

    const pinnedIds = pinned.map((row) => row.agentId);
    const recentPreview = ['recent-0', 'recent-1', 'recent-2', 'recent-3'];
    expect(visibleAgentIds()).toEqual([...pinnedIds, 'sample-live', ...recentPreview]);
    expect(button('查看更多（还有 2 条）')).toBeDefined();

    await render({ selectedAgentId: 'recent-5' });
    expect(visibleAgentIds()).toEqual([...pinnedIds, 'sample-live', ...recentPreview, 'recent-5']);
    await click('查看更多（还有 1 条）');
    expect(visibleAgentIds()).toEqual([...pinnedIds, 'sample-live', ...recent.map((row) => row.agentId)]);
    await click('收起列表');
    expect(visibleAgentIds()).toEqual([...pinnedIds, 'sample-live', ...recentPreview, 'recent-5']);
  });

  it('offers a quick pin action on live and history rows without selecting them', async () => {
    const live = projectActiveAgentRun({
      agentId: 'sample-live', phase: 'thinking', children: [], runConfig: { name: 'Sample session' },
    } as unknown as AgentControlSnapshot, 'Example');
    await render({ sessions: [live], history: [history('sample-old')], selectedAgentId: null });
    await click(defaultLabel);

    const quickPin = (agentId: string, label: string) => {
      const result = container.querySelector<HTMLButtonElement>(
        `[data-agent-id="${agentId}"] button[aria-label="${label}"]`,
      );
      expect(result).not.toBeNull();
      return result!;
    };

    await act(async () => quickPin('sample-old', '置顶').click());
    expect(visibleAgentIds()).toEqual(['sample-old', 'sample-live']);
    expect(quickPin('sample-old', '取消置顶')).not.toBeNull();
    expect(props.onSelectHistory).not.toHaveBeenCalled();

    await act(async () => quickPin('sample-live', '置顶').click());
    expect(useUIStore.getState().pinnedAgentRunIds).toEqual(['sample-old', 'sample-live']);
    expect(props.onSelectSession).not.toHaveBeenCalled();

    await act(async () => quickPin('sample-old', '取消置顶').click());
    expect(useUIStore.getState().pinnedAgentRunIds).toEqual(['sample-live']);
    expect(visibleAgentIds()).toEqual(['sample-live', 'sample-old']);
  });

  it('clears search on explicit navigation so the opened workspace remains visible', async () => {
    await render({ onNewSession: () => useUIStore.getState().setConsoleSelection({ kind: 'empty' }) });
    await search('beta');
    expect(groupNames()).toEqual(['beta']);
    await click('新会话');
    expect(container.querySelector('input')?.value).toBe('');
    expect(groupNames()).toEqual([defaultLabel, 'alpha', 'beta']);
  });

  it('reads old collapsed preferences without carrying them into new writes', async () => {
    localStorage.setItem('piskie-ui-storage', JSON.stringify({ version: 3, state: {
      theme: 'dark', consoleMode: 'thread', collapsedWorkspaceGroups: ['/sample/alpha'], retired: true,
    } }));
    await useUIStore.persist.rehydrate();
    await render();
    expect(rowCount()).toBe(0);
    await click('alpha');
    const written = JSON.parse(localStorage.getItem('piskie-ui-storage')!);
    expect(written.version).toBe(6);
    expect(Object.keys(written.state).sort()).toEqual([
      'consoleMode', 'expandedWorkspaceGroups', 'hiddenWorkspaceGroupKeys', 'pinnedAgentRunIds', 'sidebarCollapsed', 'theme', 'workspaceGroupOrder', 'workspaceSessionSort',
    ]);
  });

  it.each([false, true])('exposes new session and the complete template launcher (collapsed=%s)', async (collapsed) => {
    const definition: TaskDefinitionSnapshot = {
      definitionId: 'template-a', name: 'Sample template', description: '', purpose: 'general',
      promptTemplate: 'Sample task', defaultModeId: 'normal', defaultApprovalMode: 'confirm',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const onStart = vi.fn(); const onCreate = vi.fn(); const onEdit = vi.fn(); const onDelete = vi.fn();
    await render({ collapsed, renderTaskLauncher: (trigger) => createElement(TaskDefinitionLauncher, {
      trigger, definitions: [definition], onStart, onCreate, onEdit, onDelete,
    }) });
    await click('新会话');
    expect(props.onNewSession).toHaveBeenCalledOnce();
    await click('启动任务');
    await click('启动模板 Sample template');
    expect(onStart).toHaveBeenCalledWith(definition);
    await click('启动任务');
    await click('编辑模板 Sample template');
    expect(onEdit).toHaveBeenCalledWith(definition);
    await click('启动任务');
    await click('删除模板 Sample template');
    expect(onDelete).toHaveBeenCalledWith('template-a');
    await click('新建任务模板');
    expect(onCreate).toHaveBeenCalledOnce();
    if (!collapsed) {
      await click('在 alpha 新建会话');
      expect(props.onNewSessionIn).toHaveBeenCalledWith('/sample/alpha');
    }
  });

  it('renames from the row menu with trim, inline validation, and native dialog cancellation', async () => {
    await render({ history: [history('alpha', '/sample/alpha')] });
    await click('alpha');
    const rowMenu = () => {
      const result = container.querySelector<HTMLButtonElement>(
        '[data-agent-id="alpha"] button[aria-haspopup="menu"]',
      );
      expect(result).not.toBeNull();
      return result!;
    };
    await act(async () => rowMenu().click());
    await click('重命名…');

    const dialog = container.querySelector<HTMLDialogElement>('dialog[open]')!;
    const input = dialog.querySelector('input')!;
    const form = dialog.querySelector('form')!;
    expect(dialog.open).toBe(true);
    expect(input.value).toBe('Sample alpha');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(props.onSelectHistory).not.toHaveBeenCalled();

    await act(async () => {
      input.value = '   ';
      Simulate.change(input);
    });
    await act(async () => Simulate.submit(form));
    expect(consoleActions.renameAgentRun).not.toHaveBeenCalled();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('请输入标题');

    consoleActions.renameAgentRun.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'raw', text: 'Example rename failure' },
    });
    await act(async () => {
      input.value = '  Revised title  ';
      Simulate.change(input);
    });
    await act(async () => Simulate.submit(form));
    expect(consoleActions.renameAgentRun).toHaveBeenLastCalledWith('alpha', 'Revised title');
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Example rename failure');

    await act(async () => Simulate.submit(form));
    expect(consoleActions.renameAgentRun).toHaveBeenCalledTimes(2);
    expect(dialog.open).toBe(false);

    await act(async () => rowMenu().click());
    await click('重命名…');
    expect(dialog.open).toBe(true);
    await act(async () => dialog.close());
    expect(dialog.open).toBe(false);
    expect(consoleActions.renameAgentRun).toHaveBeenCalledTimes(2);
  });
});
