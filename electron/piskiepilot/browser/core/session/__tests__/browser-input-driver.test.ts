import { JSDOM } from 'jsdom';
import type { ElementHandle, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserInputDriver, isToggleControl } from '../browser-input-driver.js';

const dom = new JSDOM('<!doctype html><input id="sample-text" role="checkbox"><input id="sample-date" type="date"><textarea id="sample-area" role="switch"></textarea><div id="sample-editable" contenteditable="true" role="radio"></div><input id="sample-toggle" type="checkbox"><input id="sample-radio" type="radio"><button id="sample-switch" role="switch"></button>');
beforeAll(() => {
  for (const name of ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLElement']) {
    vi.stubGlobal(name, dom.window[name as 'HTMLElement']);
  }
});
afterAll(() => { vi.unstubAllGlobals(); dom.window.close(); });

function fixture(id: string) {
  const element = dom.window.document.getElementById(id)!;
  const fill = vi.fn(async (_value: string | boolean) => undefined);
  const locator = { fill, setTimeout: vi.fn() };
  locator.setTimeout.mockReturnValue(locator);
  const handle = { frame: { page: () => ({} as Page) }, evaluate: async (fn: (element: Element) => unknown) => fn(element),
    asLocator: () => locator } as unknown as ElementHandle<Element>;
  const feedback = { begin: vi.fn(() => null), finish: vi.fn(), element: vi.fn(), focus: vi.fn() };
  return { driver: new BrowserInputDriver(feedback), handle, element, fill, feedback };
}

describe('shared input value contract', () => {
  it.each(['sample-text', 'sample-date', 'sample-area'])('preserves the supported value branch despite an unrelated ARIA role on %s', async (id) => {
    const test = fixture(id);
    expect(isToggleControl(test.element)).toBe(false);
    await test.driver.fill(test.handle, id === 'sample-date' ? '2026-01-02' : 'Sample text', 5000, 'reject');
    expect(test.fill).toHaveBeenCalledOnce();
  });
  it.each(['sample-toggle', 'sample-radio', 'sample-switch'])('rejects string false on the actual toggle %s before any page action', async (id) => {
    const test = fixture(id);
    await expect(test.driver.fill(test.handle, 'false', 5000, 'reject')).rejects.toThrow('toggles are not supported');
    expect(test.fill).not.toHaveBeenCalled();
    expect(test.feedback.begin).not.toHaveBeenCalled();
  });
  it('preserves builtin boolean conversion rather than coercing a non-empty string to true', async () => {
    const test = fixture('sample-toggle');
    await test.driver.fill(test.handle, 'false', 5000, 'boolean-text');
    expect(test.fill).toHaveBeenCalledWith(false);
    await expect(test.driver.fill(test.handle, 'Sample invalid value', 5000, 'boolean-text')).rejects.toThrow('require "true" or "false"');
    expect(test.fill).toHaveBeenCalledOnce();
  });
});
