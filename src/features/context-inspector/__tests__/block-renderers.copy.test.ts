import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from '@shared/types';
import { deferred, gifBytes } from '@/features/console/attachments/__tests__/fixtures';
import { CopyButton, MessageBlocks } from '../block-renderers';

vi.mock('@/components/content-links', () => ({ LinkedMarkdown: ({ children }: { children: string }) => children }));

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const publish = vi.fn();
const writeText = vi.fn();
const bytes = gifBytes();
const source = { type: 'base64' as const, media_type: 'image/gif', data: Buffer.from(bytes).toString('base64') };

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'navigator', 'HTMLElement'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(window, { piskie: { desktop: { files: { copyImage: publish } } } });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  publish.mockReset().mockResolvedValue(undefined);
  writeText.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
const imageCopy = () => container.querySelector<HTMLButtonElement>('[data-copy-status]')!;
const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!;
async function renderImage(block: ContentBlock = { type: 'image', source }) {
  await act(async () => root.render(createElement(MessageBlocks, { message: { role: 'user', content: [block] } })));
}

describe('inspector copy controls', () => {
  it('copies original image bytes without requiring the preview, and keeps metadata copying separate', async () => {
    await renderImage();
    expect(container.querySelector('img')).toBeNull();
    await act(async () => imageCopy().click());
    expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'bytes', bytes: bytes.buffer, name: undefined });
    expect(imageCopy().textContent).toBe('Copied');
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Copy image metadata"]')!.click());
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual({ type: 'image', media_type: 'image/gif', base64Chars: source.data.length });
  });

  it('does not depend on the revocable preview URL and hides old results after replacing the image', async () => {
    const pending = deferred<void>();
    publish.mockReturnValueOnce(pending.promise);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await renderImage();
    await act(async () => button(i18n.t('contextUi.blocks.showPreview')).click());
    const url = container.querySelector('img')!.src;
    await act(async () => imageCopy().click());
    await act(async () => button(i18n.t('contextUi.blocks.hidePreview')).click());
    expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
    await renderImage({ type: 'image', source: { ...source, data: Buffer.from(gifBytes(3, 3)).toString('base64') } });
    expect(imageCopy().disabled).toBe(true);
    await act(async () => pending.resolve());
    expect(imageCopy().textContent).toBe('Copy image');
    expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'bytes', bytes: bytes.buffer, name: undefined });
  });

  it('reports image publication failure and disables image copying when source data is absent', async () => {
    publish.mockRejectedValueOnce(new Error('denied'));
    await renderImage();
    await act(async () => imageCopy().click());
    expect(imageCopy().textContent).toBe('Copy failed');
    await renderImage({ type: 'image' });
    expect(imageCopy().disabled).toBe(true);
  });

  it('shows text copy failure instead of success, then retries with the same content', async () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(CopyButton, { value: 'first\n  second' })));
    await act(async () => button('Copy').click());
    expect(button('Copying…').disabled).toBe(true);
    await act(async () => pending.reject(new Error('denied')));
    expect(button('Copy failed').disabled).toBe(false);
    await act(async () => button('Copy failed').click());
    expect(writeText).toHaveBeenLastCalledWith('first\n  second');
    expect(button('Copied')).toBeDefined();
  });
});
