import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireFilePreview, clearFilePreviews, releaseFilePreview } from '@/services/file-preview';
import { deferred } from '../../attachments/__tests__/fixtures';
import ImageLightbox from '../ImageLightbox';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const publish = vi.fn();
const releasePreview = vi.fn(async () => undefined);
const url = 'piskie-attachment://preview/sample-local';
const onClose = vi.fn();
const gallery = { urls: ['https://images.example.test/first.gif', 'https://images.example.test/second.webp'], index: 0 };

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'HTMLElement'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.assign(window, { piskie: { desktop: { files: {
    copyImage: publish, releasePreview,
    preview: async () => ({ kind: 'image', url, mediaType: 'image/gif', size: 100 }),
  } } } });
});
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  publish.mockReset().mockResolvedValue(undefined);
  releasePreview.mockClear();
  onClose.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearFilePreviews();
});
afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});
const copyButton = () => container.querySelector<HTMLButtonElement>('[data-copy-status]')!;
async function render(preview: { urls: readonly string[]; index: number } | null) {
  await act(async () => root.render(createElement(ImageLightbox, { preview, onClose })));
}
async function nextImage() {
  await act(async () => container.querySelector('dialog')!.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  ));
}

describe('lightbox copy selection', () => {
  it('copies the internally selected original URL and keeps navigation usable while busy', async () => {
    const pending = deferred<void>();
    publish.mockReturnValueOnce(pending.promise);
    await render(gallery);
    await nextImage();
    await act(async () => { copyButton().click(); copyButton().click(); });
    expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'url', url: gallery.urls[1], name: undefined });
    await nextImage();
    expect(copyButton().disabled).toBe(true);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(gallery.urls[0]);
    await act(async () => pending.resolve());
    expect(copyButton().textContent).toBe('Copy image');
    await act(async () => copyButton().click());
    expect(publish).toHaveBeenLastCalledWith({ kind: 'url', url: gallery.urls[0], name: undefined });
    expect(copyButton().textContent).toBe('Copied');
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('dialog')?.open).toBe(true);
  });

  it('holds the clicked local source after closing and keeps its result out of a reopened gallery', async () => {
    await acquireFilePreview('/workspace/assets/sample.gif');
    const pending = deferred<void>();
    publish.mockReturnValueOnce(pending.promise);
    await render({ urls: [url], index: 0 });
    await act(async () => copyButton().click());
    await render(null);
    releaseFilePreview(url);
    expect(releasePreview).not.toHaveBeenCalled();
    await render(gallery);
    expect(copyButton().disabled).toBe(true);
    await act(async () => pending.resolve());
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith(url);
    expect(copyButton().textContent).toBe('Copy image');
  });

  it('reports a failed desktop publication and allows copying again', async () => {
    publish.mockRejectedValueOnce(new Error('publication denied'));
    await render(gallery);
    await act(async () => copyButton().click());
    expect(copyButton().textContent).toBe('Copy failed');
    expect(copyButton().disabled).toBe(false);
    await act(async () => copyButton().click());
    expect(copyButton().textContent).toBe('Copied');
  });
});
