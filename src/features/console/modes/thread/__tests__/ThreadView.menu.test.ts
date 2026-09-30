import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PopoverProps } from '../../../chrome/Popover';
import { ThreadView } from '../ThreadView';

vi.mock('../../../data/vm', () => ({
  useAgentVM: (agentId: string) => ({ agentId, title: `Example ${agentId}`, workers: [] }),
  useWorkerVM: () => undefined,
  resolveConversationTarget: () => ({ status: 'waiting', phase: 'waiting', pendingEvents: [] }),
  resolveConversationBrowserResources: () => [],
  projectWorkerTasks: () => [],
}));
vi.mock('../../../data/actions', () => ({ useConsoleActions: () => ({}) }));
vi.mock('../../../data/useTranscript', () => ({ useTranscript: () => ({ nodes: [], responses: [], workers: [], loaded: true }) }));
vi.mock('../../../data/useFileChanges', () => ({ useFileChanges: () => ({ totals: { filesChanged: 0, added: 0, removed: 0 } }) }));
vi.mock('../../../data/useMarkSessionRead', () => ({ useMarkSessionRead: () => undefined }));
vi.mock('../../../content/activePrimaryOwner', () => ({ useActivePrimaryOwner: () => ({}) }));
vi.mock('../../../content/useActionScope', () => ({ useActionScope: () => ({}) }));
vi.mock('../../../content/composer/ConversationComposer', () => ({ ConversationComposer: () => null }));
vi.mock('../../../content/composer/PendingEventQueue', () => ({ PendingEventQueue: () => null }));
vi.mock('../../../content/Transcript', () => ({ Transcript: () => null }));
vi.mock('../../../content/ThreadCell', () => ({ ThreadCell: () => null }));
vi.mock('../../../content/TaskList', () => ({ TaskList: () => null }));
vi.mock('../../../content/Gate', () => ({ Gate: () => null }));
vi.mock('../../../content/ImageReview', () => ({ ImageReview: () => null }));
vi.mock('../../../content/AgentMetricsStrip', () => ({ AgentMetricsStrip: () => null }));
vi.mock('../../../content/AIRequestStatus', () => ({ AIRequestStatus: () => null }));
vi.mock('../../../content/McpRuntimeCard', () => ({ McpRuntimeCard: () => null }));
vi.mock('../../../content/FileChangeSummary', () => ({ FileChangeSummary: () => null }));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../../chrome/Popover', () => ({
  Popover: ({ trigger, open, children }: PopoverProps) => createElement('div', null, trigger, open ? children : null),
}));

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const select = vi.fn();
const items = [{ key: 'trace', label: 'Example trace' }, { key: 'stop', label: 'Example stop', danger: true }];
async function render(agentId = 'sample-a', onMenuSelect = select) {
  await act(async () => root.render(createElement(ThreadView, { agentId, menuItems: items, onMenuSelect })));
}
async function context() {
  const title = [...container.querySelectorAll('span')].find((element) => element.textContent === 'Example sample-a')!;
  await act(async () => title.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
}
async function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label)!;
  expect(button, label).toBeDefined();
  await act(async () => button.click());
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getAnimations', { value: () => [] });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'showModal', {
    value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'close', {
    value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); },
  });
  select.mockReset();
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

describe('thread title menu', () => {
  it('uses the same actions for the existing button and right click without dispatching on open', async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    await act(async () => trigger.click());
    const labels = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    await act(async () => trigger.click());
    await context();
    expect([...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(labels);
    expect(select).not.toHaveBeenCalled();
    await click('Example trace');
    expect(select).toHaveBeenCalledWith('trace');
    expect(container.querySelectorAll('button[aria-haspopup="menu"]')).toHaveLength(1);
  });

  it('confirms stop through either entry and keeps the original target if navigation changes', async () => {
    await render();
    await context();
    await click('停止…');
    expect(select).not.toHaveBeenCalled();
    await click('取消');
    expect(select).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    await click('停止…');
    const other = vi.fn();
    await render('sample-b', other);
    await click('停止');
    expect(select).toHaveBeenCalledExactlyOnceWith('stop');
    expect(other).not.toHaveBeenCalled();
  });
});
