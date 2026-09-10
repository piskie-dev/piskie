import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTarget } from '../../../../../../shared/types/agent-control';
import { EMPTY_EMBEDDED_BROWSER_STATE, type EmbeddedBrowserState } from '../../../../../../shared/types/embedded-browser';
import { ThreadMode, type ThreadModeProps } from '../ThreadMode';

vi.mock('../../../data/vm', () => ({
  useAgentVM: (agentId: string) => ({
    agentId, title: agentId, status: 'waiting', workers: [
      { id: 'worker-one', subject: 'Worker one', type: 'browser-worker', status: 'waiting' },
    ],
  }),
  useWorkerVM: (_agentId: string, workerId?: string) => workerId ? {
    id: workerId, subject: 'Worker one', browserId: 'automation-one', browserReady: true,
  } : null,
}));
vi.mock('../../../data/actions', () => ({ useConsoleActions: () => ({}) }));
vi.mock('../../../data/useImageNodes', () => ({ useImageNodes: () => [] }));
vi.mock('../../../data/useKeyboard', () => ({ useGlobalBinding: () => undefined }));
vi.mock('../../../content/ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../../../content/ReviewSlot', () => ({ ReviewSlot: () => null }));
vi.mock('../ThreadView', () => ({ ThreadView: () => null }));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../../content/ScreenView', () => ({
  BrowserScreenView: ({ browserId }: { browserId: string }) => createElement('div', { 'data-screen': browserId }),
}));
vi.mock('@/components/content-links', () => ({
  ContentLinkUrlScope: ({ children, onOpenUrl }: { children: ReactNode; onOpenUrl: (url: string) => void }) => (
    createElement('div', null,
      createElement('button', { onClick: () => onOpenUrl('https://example.test/page') }, 'Open preview link'),
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
  Object.assign(dom.window, { piskie: { pilot: { embeddedBrowser: api } } });
});
beforeEach(() => {
  vi.clearAllMocks();
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

describe('thread preview controls', () => {
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
    await click('展开右侧栏');
    expect(api.open).toHaveBeenCalledOnce();
    expect(address()?.value).toBe('');
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
