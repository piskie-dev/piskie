import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@/features/console/attachments/__tests__/fixtures';
import { CopyActionButton } from '../CopyActionButton';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'HTMLElement'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

const button = () => container.querySelector('button')!;
const render = (contentKey: string, onCopy: () => Promise<void>, iconOnly = false) => act(async () => {
  root.render(createElement(CopyActionButton, { contentKey, onCopy, label: 'Copy sample', iconOnly }));
});

describe('shared copy feedback', () => {
  it('keeps status text available to assistive technology in icon-only mode', async () => {
    await render('image:first', async () => undefined, true);
    const label = button().querySelector('span')!;
    expect(label.textContent).toBe('Copy sample');
    expect(label.className).toContain('visuallyHidden');
    expect(label.getAttribute('aria-live')).toBe('polite');
    expect(button().getAttribute('aria-label')).toBe('Copy sample');
    expect(button().getAttribute('title')).toBe('Copy sample');
  });

  it('locks immediately, waits for publication, then expires success feedback', async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const copy = vi.fn(() => pending.promise);
    await render('image:first', copy);
    await act(async () => { button().click(); button().click(); });
    expect(copy).toHaveBeenCalledOnce();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('Copying…');
    await act(async () => pending.resolve());
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe('Copied');
    await act(async () => vi.advanceTimersByTime(1_600));
    expect(button().textContent).toBe('Copy sample');
  });

  it.each(['success', 'failure'] as const)('keeps the toolbar busy across views and discards late %s feedback', async (outcome) => {
    const pending = deferred<void>();
    const firstCopy = vi.fn(() => pending.promise);
    const nextCopy = vi.fn(async () => undefined);
    await render('diagram:first', firstCopy);
    await act(async () => button().click());
    await render('source:first', nextCopy);
    await act(async () => button().click());
    expect(nextCopy).not.toHaveBeenCalled();
    // Returning to the same content is a new visit, not the original click owner.
    await render('diagram:first', nextCopy);
    await act(async () => {
      if (outcome === 'success') pending.resolve();
      else pending.reject(new Error('copy failed'));
    });
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe('Copy sample');
    await act(async () => button().click());
    expect(nextCopy).toHaveBeenCalledOnce();
    expect(button().textContent).toBe('Copied');
  });

  it('shows failures, allows retry, and reprojects feedback when the locale changes', async () => {
    const copy = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
    await render('sample', copy);
    await act(async () => button().click());
    expect(button().textContent).toBe('Copy failed');
    expect(button().disabled).toBe(false);
    await act(async () => i18n.changeLanguage('zh-CN'));
    expect(button().textContent).toBe('复制失败');
    await act(async () => button().click());
    expect(button().textContent).toBe('已复制');
  });

  it('lets the clicked operation finish after its view is unmounted', async () => {
    const pending = deferred<void>();
    const finished = vi.fn();
    await render('sample', async () => { await pending.promise; finished(); });
    await act(async () => button().click());
    await act(async () => root.render(null));
    await act(async () => pending.resolve());
    expect(finished).toHaveBeenCalledOnce();
    expect(container.childElementCount).toBe(0);
  });
});
