import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentTabs, type AgentTabItem } from '../AgentTabs';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let trackScrollWidth = 800;
let lastScrolledLabel = '';
const scrollBy = vi.fn();

const items: readonly AgentTabItem[] = [
  { label: '主会话', status: 'running' },
  ...Array.from({ length: 8 }, (_, index) => ({
    workerId: `worker-${index + 1}`,
    label: `Worker ${index + 1}`,
    mode: 'local' as const,
    status: 'running' as const,
  })),
];

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });

  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.getAttribute('role') === 'tablist' ? 240 : 0;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return this.getAttribute('role') === 'tablist' ? trackScrollWidth : 0;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollBy', {
    configurable: true,
    value: scrollBy,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: HTMLElement) {
      lastScrolledLabel = this.textContent ?? '';
    },
  });
});

beforeEach(() => {
  trackScrollWidth = 800;
  lastScrolledLabel = '';
  scrollBy.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('AgentTabs overflow navigation', () => {
  it('keeps paging controls reachable and scrolls a newly selected Worker into view', async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(createElement(AgentTabs, { items, onSelect }));
    });

    const previous = container.querySelector<HTMLButtonElement>('[aria-label="上一页"]');
    const next = container.querySelector<HTMLButtonElement>('[aria-label="下一页"]');
    const track = container.querySelector<HTMLElement>('[role="tablist"]');
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(false);
    expect(track).not.toBeNull();

    await act(async () => {
      next?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(scrollBy).toHaveBeenCalledWith({ left: 200, behavior: 'smooth' });

    if (!track) throw new Error('Agent tab track did not render');
    track.scrollLeft = 560;
    await act(async () => {
      track.dispatchEvent(new Event('scroll'));
    });
    expect(container.querySelector<HTMLButtonElement>('[aria-label="上一页"]')?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="下一页"]')?.disabled).toBe(true);

    await act(async () => {
      root.render(createElement(AgentTabs, {
        items,
        selectedWorkerId: 'worker-8',
        onSelect,
      }));
    });
    expect(lastScrolledLabel).toContain('Worker 8');
  });

  it('does not show paging buttons when the tabs fit', async () => {
    trackScrollWidth = 200;
    await act(async () => {
      root.render(createElement(AgentTabs, { items: items.slice(0, 2), onSelect: vi.fn() }));
    });

    expect(container.querySelector('[aria-label="上一页"]')).toBeNull();
    expect(container.querySelector('[aria-label="下一页"]')).toBeNull();
  });
});
