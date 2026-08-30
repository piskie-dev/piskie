import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/utils/platform', () => ({ isMacOSPlatform: () => false }));

import type { ThinkNode } from '@/domains/transcript/nodes';

let ThreadCell: typeof import('../ThreadCell').ThreadCell;
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
const nodeRequire = createRequire(import.meta.url);
const previousCssLoader = nodeRequire.extensions['.css'];

function think(markdown: string, live: boolean): ThinkNode {
  return {
    kind: 'think',
    id: 'think-1',
    ts: 1,
    sourceIndex: live ? -1 : 0,
    titleKey: 'Think',
    markdown,
    live,
    tone: live ? 'live' : 'muted',
    interaction: 'none',
    defaultExpanded: true,
    summaryDuplicatesDetail: false,
  };
}

async function renderNode(node: ThinkNode): Promise<void> {
  await act(async () => {
    root.render(createElement(ThreadCell, { cell: node }));
  });
}

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://piskie.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('SVGElement', dom.window.SVGElement);
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  nodeRequire.extensions['.css'] = () => undefined;
  ({ ThreadCell } = await import('../ThreadCell'));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await i18n.changeLanguage('zh-CN');
});

afterAll(() => {
  if (previousCssLoader) nodeRequire.extensions['.css'] = previousCssLoader;
  else delete nodeRequire.extensions['.css'];
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('Think disclosure', () => {
  it('keeps the Think term in English for both interface locales', async () => {
    await i18n.changeLanguage('zh-CN');
    await renderNode(think('Inspect the request', false));
    expect(container.querySelector('[data-think-toggle]')?.textContent).toContain('Think');

    await act(async () => i18n.changeLanguage('en-US'));
    expect(container.querySelector('[data-think-toggle]')?.textContent).toContain('Think');
  });

  it('keeps the live Thinking term in English for both interface locales', async () => {
    await i18n.changeLanguage('zh-CN');
    await renderNode(think('Inspect the request', true));
    expect(container.querySelector('[data-think-toggle]')?.textContent).toContain('Thinking');

    await act(async () => i18n.changeLanguage('en-US'));
    expect(container.querySelector('[data-think-toggle]')?.textContent).toContain('Thinking');
  });

  it('starts on one settled summary line and expands the complete content', async () => {
    await renderNode(think('Inspect the request\nCheck cache reuse', false));

    const toggle = container.querySelector<HTMLElement>('[data-think-toggle]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-think-summary]')?.textContent?.trimEnd())
      .toBe('Inspect the request');
    expect(container.querySelector('[data-think-body]')).toBeNull();

    await act(async () => toggle.click());

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-think-summary]')).toBeNull();
    expect(container.querySelector('[data-think-body]')?.textContent).toContain('Inspect the request');
    expect(container.querySelector('[data-think-body]')?.textContent).toContain('Check cache reuse');
  });

  it('renders the collapsed line through XMarkdown', async () => {
    await renderNode(think('**Adjusting error listener placement**', false));

    const summary = container.querySelector<HTMLElement>('[data-think-summary]')!;
    expect(summary.querySelector('.x-markdown')).not.toBeNull();
    expect(summary.querySelector('strong')?.textContent).toBe('Adjusting error listener placement');
    expect(summary.textContent).not.toContain('**');
  });

  it('uses the same XMarkdown rendering for adjacent bold boundaries', async () => {
    const markdown = '**xxx****xxxxxx**';
    await renderNode(think(markdown, false));

    const collapsed = container.querySelector<HTMLElement>('[data-think-summary]')!;
    const collapsedMarkdown = collapsed.querySelector<HTMLElement>('.x-markdown')!;
    const collapsedHtml = collapsedMarkdown.innerHTML;

    await act(async () => container.querySelector<HTMLElement>('[data-think-toggle]')!.click());

    const expandedMarkdown = container.querySelector<HTMLElement>('[data-think-body] .x-markdown')!;
    expect(collapsedHtml).toBe(expandedMarkdown.innerHTML);
  });

  it('follows the latest live line and returns to the first line when settled', async () => {
    await renderNode(think('Inspect the request\nNewest reasoning tokens', true));
    const summary = container.querySelector<HTMLElement>('[data-think-summary]')!;
    expect(container.querySelector('[data-orb-variant="expanding"]')).not.toBeNull();
    expect(summary.textContent.trimEnd()).toBe('Newest reasoning tokens');
    expect(summary.hasAttribute('data-follow-end')).toBe(true);
    Object.defineProperties(summary, {
      scrollWidth: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 100 },
    });

    await renderNode(think('Inspect the request\nNewest reasoning tokens keep arriving', true));
    expect(summary.textContent.trimEnd()).toBe('Newest reasoning tokens keep arriving');
    expect(summary.scrollLeft).toBe(200);

    await renderNode(think('Inspect the request\nNewest reasoning tokens keep arriving', false));
    expect(container.querySelector('[data-orb-variant]')).toBeNull();
    expect(summary.textContent.trimEnd()).toBe('Inspect the request');
    expect(summary.hasAttribute('data-follow-end')).toBe(false);
    expect(summary.scrollLeft).toBe(0);
  });
});
