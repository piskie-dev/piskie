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
import type { FileReviewTarget } from '../../../content/fileReviewTarget';
import type { FilePreviewDescriptor } from '@shared/electron-contracts/desktop';

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
vi.mock('../../../content/ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../../../content/ReviewSlot', () => ({ ReviewSlot: ({ target }: { target?: FileReviewTarget }) => createElement('div', {
  'data-review-kind': target?.kind,
  'data-review-path': target?.kind === 'path' ? target.path : undefined,
  'data-preview-kind': target?.kind === 'path' ? target.preview.kind : undefined,
}) }));
vi.mock('../ThreadView', () => ({ ThreadView: ({ onToggleFileChanges, fileChangesOpen, onOpenFileChange }: ThreadViewProps) => createElement('div', null,
  createElement(FileChangeSummary, { changes: { filesChanged: 1, added: 1, removed: 0 }, expanded: fileChangesOpen, onToggle: onToggleFileChanges }),
  createElement('button', { onClick: () => onOpenFileChange?.('sample-call') }, 'Open sample call'),
) }));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../../content/ScreenView', () => ({
  BrowserScreenView: ({ browserId }: { browserId: string }) => createElement('div', { 'data-screen': browserId }),
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
  preview.mockReset().mockResolvedValue({ kind: 'directory' });
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
    await click('展开右侧栏');
    expect(api.open).toHaveBeenCalledOnce();
    expect(address()?.value).toBe('');
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
