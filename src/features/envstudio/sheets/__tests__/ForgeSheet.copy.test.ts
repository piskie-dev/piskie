import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@/features/console/attachments/__tests__/fixtures';
import { ForgeSheet } from '../ForgeSheet';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const writeText = vi.fn();
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'navigator', 'HTMLElement'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  writeText.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

describe('environment user-agent copying', () => {
  it('keeps the existing control and fault area while awaiting failure and retry success', async () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(ForgeSheet, {
      env: null, proxies: [], kernelBuild: '128.0.1', onClose: vi.fn(), onSaved: vi.fn(),
    })));
    const generate = container.querySelector<HTMLButtonElement>(`button[title="${i18n.t('environmentUi.forge.generateUa')}"]`)!;
    const copy = container.querySelector<HTMLButtonElement>(`button[title="${i18n.t('environmentUi.forge.copyUa')}"]`)!;
    await act(async () => generate.click());
    const value = container.querySelector<HTMLInputElement>(`input[placeholder="${i18n.t('environmentUi.forge.userAgentPlaceholder')}"]`)!.value;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(value);
    expect(copy.disabled).toBe(true);
    expect(copy.textContent).toBe('Copying…');
    await act(async () => pending.reject(new Error('denied')));
    expect(container.querySelector('footer')?.textContent).toContain(i18n.t('environmentUi.forge.copyFailed'));
    expect(copy.disabled).toBe(false);
    await act(async () => copy.click());
    expect(copy.textContent).toBe('Copied');
    expect(container.querySelector('footer')?.textContent).not.toContain(i18n.t('environmentUi.forge.copyFailed'));
  });
});
