import { act, createElement, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { JSDOM } from 'jsdom';
import { createJSONStorage } from 'zustand/middleware';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDefinitionSnapshot } from '../../../../../shared/electron-contracts/task-definitions';
import { useUIStore } from '../../../../store/uiStore';
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
async function render(next: Partial<ThreadSidebarProps> = {}) {
  props = { ...props, ...next };
  await act(async () => root.render(createElement(ThreadSidebar, props)));
}
async function click(label: string) { await act(async () => button(label).click()); }
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

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Event', dom.window.Event);
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
  useUIStore.setState({ expandedWorkspaceGroups: [], workspaceGroupOrder: [], consoleSelection: null });
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
    expect(written.version).toBe(4);
    expect(Object.keys(written.state).sort()).toEqual([
      'consoleMode', 'expandedWorkspaceGroups', 'sidebarCollapsed', 'theme', 'workspaceGroupOrder',
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
    await click('重命名');

    const dialog = container.querySelector('dialog')!;
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
    await click('重命名');
    expect(dialog.open).toBe(true);
    await act(async () => dialog.close());
    expect(dialog.open).toBe(false);
    expect(consoleActions.renameAgentRun).toHaveBeenCalledTimes(2);
  });
});
