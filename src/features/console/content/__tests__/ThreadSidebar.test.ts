import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { JSDOM } from 'jsdom';
import { createJSONStorage } from 'zustand/middleware';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDefinitionSnapshot } from '../../../../../shared/electron-contracts/task-definitions';
import { useUIStore } from '../../../../store/uiStore';
import type { PopoverProps } from '../../chrome/Popover';
import type { HistoryRow } from '../../data/sessionRow';
import { TaskDefinitionLauncher } from '../../shell/TaskDefinitionLauncher';
import { ThreadSidebar, type ThreadSidebarProps } from '../ThreadSidebar';

const historyState = vi.hoisted(() => ({ ready: true }));
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
vi.mock('../../data/actions', () => ({ useConsoleActions: () => ({}) }));
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
  useUIStore.persist.setOptions({ storage: createJSONStorage(() => localStorage) });
  localStorage.clear();
  useUIStore.setState({ expandedWorkspaceGroups: [], workspaceGroupOrder: [], consoleSelection: null });
  historyState.ready = true;
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
});
