const dom = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const testDOM = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test',
  });
  vi.stubGlobal('window', testDOM.window);
  for (const name of ['document', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    vi.stubGlobal(name, testDOM.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return testDOM;
});

import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentClient } from '@shared/electron-contracts/agents';
import type { CompactionHistoryView } from '@shared/types/context';
import type { ContextSnapshot } from '@shared/types/token';
import { RendererRuntimeContext } from '@/renderer-runtime/renderer-runtime-context';
import type { RendererRuntime } from '@/renderer-runtime/renderer-runtime';
import { ContextInspector } from '../ContextInspector';
import { createContextInspectorResource, type ContextInspectorResource } from '../context-inspector-resource';
import styles from '../context-inspector.module.css';

vi.mock('@/components/content-links', () => ({
  LinkedMarkdown: ({ children }: { readonly children: string }) => children,
}));

let container: HTMLDivElement;
let root: Root;
let resource: ContextInspectorResource;
let runtime: RendererRuntime;
let sourceVersion: number;
const context = vi.fn<AgentClient['context']>();
const listCompactions = vi.fn<(agentId: string) => Promise<CompactionHistoryView>>();
const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
  this.scrollTop = options.top ?? 0;
  this.dispatchEvent(new Event('scroll'));
});

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 90,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(window, 'piskie', { value: { agentRuns: { listCompactions } } });
});

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  context.mockReset().mockResolvedValue(snapshot());
  listCompactions.mockReset();
  scrollTo.mockClear();
  resource = createContextInspectorResource({ context } as unknown as AgentClient);
  runtime = { contextInspector: resource } as RendererRuntime;
  sourceVersion = 1;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  resource.close();
  container.remove();
  await i18n.changeLanguage('zh-CN');
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('ContextInspector reading during refresh', () => {
  it('keeps the scrolled ledger in place while an append refresh starts and completes', async () => {
    await render();
    const viewport = ledger();
    await scroll(viewport, 900);
    expect(viewport.textContent).toContain('Message 030');
    scrollTo.mockClear();

    const pending = deferred<ContextSnapshot>();
    context.mockReturnValueOnce(pending.promise);
    sourceVersion += 1;
    await render();
    expect(resource.state.getState().phase).toBe('refreshing');
    expect(viewport.scrollTop).toBe(900);

    await act(async () => pending.resolve(snapshot(81)));
    expect(resource.state.getState()).toMatchObject({ phase: 'ready', generation: 2 });
    expect(container.querySelectorAll('[data-context-timeline-record-index]')).toHaveLength(84);
    expect(ledger()).toBe(viewport);
    expect(viewport.scrollTop).toBe(900);
    expect(viewport.textContent).toContain('Message 030');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('preserves the default detail scroll and raw tab while displaying refreshed content', async () => {
    await render();
    await clickTab('raw');
    const body = detailBody();
    await scroll(body, 360);

    await refresh({ ...snapshot(81), systemPrompt: 'Updated system text\n'.repeat(80) });
    expect(detailBody()).toBe(body);
    expect(detailBody().scrollTop).toBe(360);
    expect(selectedTab()).toBe('raw');
    expect(body.textContent).toContain('Updated system text');
  });

  it.each(['tool', 'user'] as const)('preserves the default %s detail in a filtered list', async (filter) => {
    await render();
    await clickFilter(filter);
    const body = detailBody();
    await scroll(body, 240);

    await refresh(snapshot(81));
    expect(detailBody()).toBe(body);
    expect(detailBody().scrollTop).toBe(240);
  });

  it('keeps a manually selected message and its detail while the list is scrolled elsewhere', async () => {
    await render();
    await scroll(ledger(), 300);
    await clickLedgerMessage('Message 010');
    await clickTab('raw');
    const body = detailBody();
    await scroll(body, 180);
    await scroll(ledger(), 900);
    scrollTo.mockClear();

    await refresh(snapshot(81));
    await refresh(snapshot(82));
    expect(ledger().scrollTop).toBe(900);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(detailBody()).toBe(body);
    expect(body.scrollTop).toBe(180);
    expect(selectedTab()).toBe('raw');
    expect(body.textContent).toContain('Message 010');

    await clickLedgerMessage('Message 030');
    expect(detailBody()).not.toBe(body);
    expect(detailBody().scrollTop).toBe(0);
    expect(selectedTab()).toBe('content');
    expect(detailBody().textContent).toContain('Message 030');
  });

  it('preserves a selected tool detail when refreshed tools change order', async () => {
    await render();
    await clickFilter('tool');
    await click(buttonWithText('lookup_record', ledger()));
    const body = detailBody();
    await scroll(body, 150);
    const next = snapshot(81);

    await refresh({ ...next, tools: [...next.tools].reverse() });
    expect(detailBody()).toBe(body);
    expect(body.scrollTop).toBe(150);
    expect(body.textContent).toContain('lookup_record');
    expect(selectedLedgerRow().textContent).toContain('lookup_record');
  });
});

describe('ContextInspector intentional navigation', () => {
  it('reveals search matches in both directions and restores the intended selection after filtering', async () => {
    await render();
    await clickLedgerMessage('Message 000');
    await scroll(ledger(), 900);
    await search('Message');
    expect(ledger().scrollTop).toBe(0);

    await clickNavigation('previousMatch');
    expectSelectedRowVisible();
    expect(detailBody().textContent).toContain('Message 079');
    await clickNavigation('nextMatch');
    expectSelectedRowVisible();
    expect(detailBody().textContent).toContain('Message 000');
    await clickNavigation('nextMatch');
    expect(detailBody().textContent).toContain('Message 001');

    await search('Message 020');
    expect(detailBody().textContent).toContain('Message 020');
    await search('');
    expect(detailBody().textContent).toContain('Message 001');
    expectSelectedRowVisible();

    await scroll(ledger(), 900);
    await clickFilter('user');
    expectSelectedRowVisible();
    expect(detailBody().textContent).toContain('Message 000');
  });

  it('reveals a clicked timeline record even when it was already selected', async () => {
    await render();
    await scroll(ledger(), 900);
    await timelineClick(0);
    expect(ledger().scrollTop).toBe(0);
    expectSelectedRowVisible();

    await timelineKey('End');
    expectSelectedRowVisible();
    expect(detailBody().textContent).toContain('Message 079');
    await scroll(ledger(), 0);
    await timelineKey('End');
    expectSelectedRowVisible();

    await search('Message 020');
    await timelineClick(33);
    expect(element<HTMLInputElement>('input').value).toBe('');
    expect(detailBody().textContent).toContain('Message 030');
    expectSelectedRowVisible();
  });

  it('locates a timeline range without pulling the reader back after a refresh', async () => {
    await render();
    const track = timelineTrack();
    await act(async () => {
      dispatchPointer(track, 'pointerdown', 400);
      dispatchPointer(track, 'pointermove', 500);
      dispatchPointer(track, 'pointerup', 500);
    });
    expect(ledger().scrollTop).toBe(1200);
    expect(ledger().querySelector('[data-timeline-focus="inside"]')).not.toBeNull();
    await scroll(ledger(), 1800);
    scrollTo.mockClear();

    await refresh(snapshot(81));
    expect(ledger().scrollTop).toBe(1800);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(ledger().querySelector('[data-timeline-focus]')).toBeNull();
  });
});

describe('ContextInspector detail lifecycle', () => {
  it('resets a replaced summary at the same index and ignores its outstanding history response', async () => {
    context.mockResolvedValueOnce(summarySnapshot('First summary'));
    await render();
    await clickFilter('user');
    const body = detailBody();
    const pending = deferred<CompactionHistoryView>();
    listCompactions.mockReturnValueOnce(pending.promise);
    await clickHistory();
    await scroll(body, 180);

    await refresh(summarySnapshot('Replacement summary'));
    expect(detailBody()).not.toBe(body);
    expect(detailBody().scrollTop).toBe(0);
    expect(detailBody().textContent).toContain('Replacement summary');
    await act(async () => pending.resolve(history()));
    expect(container.querySelector(`.${styles.archivePhase}`)).toBeNull();

    listCompactions.mockResolvedValueOnce(history());
    await clickHistory();
    expect(listCompactions).toHaveBeenCalledTimes(2);
    expect(container.querySelector(`.${styles.archivePhase}`)).not.toBeNull();
  });

  it('retains pending history for an unchanged summary but isolates it when changing agents', async () => {
    context.mockResolvedValueOnce(summarySnapshot('Shared summary'));
    await render();
    await clickFilter('user');
    const body = detailBody();
    const pending = deferred<CompactionHistoryView>();
    listCompactions.mockReturnValueOnce(pending.promise);
    await clickHistory();

    await refresh(summarySnapshot('Shared summary'));
    expect(detailBody()).toBe(body);
    expect(buttonWithText(i18n.t('contextUi.history.view'))).toHaveProperty('disabled', true);

    context.mockResolvedValueOnce(summarySnapshot('Shared summary'));
    await render('agent-b');
    expect(detailBody()).not.toBe(body);
    expect(detailBody().scrollTop).toBe(0);
    expect(ledger().scrollTop).toBe(0);
    expect(context).toHaveBeenLastCalledWith('agent-b');
    await act(async () => pending.resolve(history()));
    expect(container.querySelector(`.${styles.archivePhase}`)).toBeNull();
    expect(buttonWithText(i18n.t('contextUi.history.view'))).toHaveProperty('disabled', false);
  });
});

function snapshot(messageCount = 80): ContextSnapshot {
  return {
    systemPrompt: 'Example system text\n'.repeat(80),
    tools: ['lookup_record', 'read_record'].map((name) => ({
      name,
      description: `Definition for ${name}`,
      input_schema: { type: 'object', properties: {} },
    })),
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${String(index).padStart(3, '0')}\n${'Example detail text\n'.repeat(40)}`,
    })),
    requestTokenCheckpoints: [],
    usage: { tokens: 500, limit: 10_000, percentage: 5 },
  };
}

function summarySnapshot(content: string): ContextSnapshot {
  return {
    ...snapshot(0),
    messages: [{ role: 'user', subtype: 'context_summary', content }],
  };
}

function history(): CompactionHistoryView {
  return {
    summaries: [{
      id: 'summary-a',
      markdown: 'Archived summary',
      compressedCount: 4,
      originalTokens: 200,
      createdAt: 1,
      hasOriginalMessages: true,
    }],
    stats: { totalCompactions: 1 },
  };
}

async function render(agentId = 'agent-a'): Promise<void> {
  await act(async () => {
    root.render(createElement(RendererRuntimeContext.Provider, { value: runtime },
      createElement(ContextInspector, { open: true, onClose: vi.fn(), agentId, sourceVersion })));
  });
}

async function refresh(next: ContextSnapshot): Promise<void> {
  context.mockResolvedValueOnce(next);
  sourceVersion += 1;
  await render();
}

function element<T extends HTMLElement = HTMLElement>(selector: string, parent: ParentNode = container): T {
  const target = parent.querySelector<T>(selector);
  if (!target) throw new Error(`Missing element: ${selector}`);
  return target;
}

function ledger(): HTMLDivElement {
  return element(`.${styles.ledgerViewport}`);
}

function detailBody(): HTMLDivElement {
  return element(`.${styles.localBody}`);
}

function buttonWithText(text: string, parent: ParentNode = container): HTMLButtonElement {
  const button = [...parent.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}

async function clickFilter(filter: 'tool' | 'user'): Promise<void> {
  await click(buttonWithText(i18n.t(filter === 'tool' ? 'contextUi.filterTool' : 'contextUi.filterUser'),
    element(`.${styles.filters}`)));
}

async function clickLedgerMessage(text: string): Promise<void> {
  await click(buttonWithText(text, ledger()));
}

async function clickTab(tab: 'raw' | 'content'): Promise<void> {
  await click(buttonWithText(i18n.t(`contextUi.inspector.${tab}`), element('[role="tablist"]')));
}

function selectedTab(): 'raw' | 'content' {
  return element('[role="tab"][aria-selected="true"]').textContent === i18n.t('contextUi.inspector.raw')
    ? 'raw' : 'content';
}

async function clickNavigation(direction: 'previousMatch' | 'nextMatch'): Promise<void> {
  await click(element(`[aria-label="${i18n.t(`contextUi.${direction}`)}"]`));
}

async function clickHistory(): Promise<void> {
  await click(buttonWithText(i18n.t('contextUi.history.view')));
}

async function scroll(target: HTMLElement, top: number): Promise<void> {
  await act(async () => {
    target.scrollTop = top;
    target.dispatchEvent(new Event('scroll'));
  });
}

async function search(value: string): Promise<void> {
  const input = element<HTMLInputElement>('input');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe(value);
}

function selectedLedgerRow(): HTMLButtonElement {
  return element('button[data-selected]', ledger());
}

function expectSelectedRowVisible(): void {
  const top = Number(selectedLedgerRow().style.transform.match(/translateY\((\d+)px\)/)?.[1]);
  expect(top).toBeGreaterThanOrEqual(ledger().scrollTop);
  expect(top + 30).toBeLessThanOrEqual(ledger().scrollTop + ledger().clientHeight);
}

function timelineTrack(): HTMLElement {
  const track = element('[data-context-timeline-track]');
  const width = container.querySelectorAll('[data-context-timeline-record-index]').length * 10;
  track.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, width, 50);
  return track;
}

async function timelineClick(index: number): Promise<void> {
  timelineTrack();
  const target = element(`[data-context-timeline-record-index="${index}"]`);
  await act(async () => {
    dispatchPointer(target, 'pointerdown', index * 10 + 5);
    dispatchPointer(target, 'pointerup', index * 10 + 5);
  });
}

async function timelineKey(key: string): Promise<void> {
  await act(async () => {
    timelineTrack().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
}

function dispatchPointer(target: HTMLElement, type: string, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}
