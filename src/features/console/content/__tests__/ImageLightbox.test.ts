import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import ImageLightbox from '../ImageLightbox';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLDialogElement', dom.window.HTMLDialogElement);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.removeAttribute('open');
    },
  });
});

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
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

describe('ImageLightbox context navigation', () => {
  it('keeps a single-image preview free of gallery controls', async () => {
    await act(async () => {
      root.render(createElement(ImageLightbox, {
        preview: { urls: ['https://example.test/only.png'], index: 0 },
        onClose: vi.fn(),
      }));
    });

    expect(container.querySelector('img[alt^="第"]')?.getAttribute('src'))
      .toBe('https://example.test/only.png');
    expect(container.querySelector('button[aria-label="上一张图片"]')).toBeNull();
    expect(container.querySelector('button[aria-label="下一张图片"]')).toBeNull();
    expect(container.querySelector('[aria-label="当前会话中的图片"]')).toBeNull();
    expect(container.querySelector('button[aria-label="关闭预览"]')).not.toBeNull();
  });

  it('starts at the clicked image and browses with controls, thumbnails, and arrow keys', async () => {
    const urls = [
      'https://example.test/one.png',
      'https://example.test/two.png',
      'https://example.test/three.png',
    ];

    await act(async () => {
      root.render(createElement(ImageLightbox, {
        preview: { urls, index: 1 },
        onClose: vi.fn(),
      }));
    });

    const dialog = container.querySelector('dialog');
    const currentPicture = () => container.querySelector<HTMLImageElement>('img[alt^="第"]');
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(currentPicture()?.getAttribute('src')).toBe(urls[1]);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('2 / 3');

    await act(async () => button('下一张图片')?.click());
    expect(currentPicture()?.getAttribute('src')).toBe(urls[2]);

    await act(async () => {
      dialog?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
      }));
    });
    expect(currentPicture()?.getAttribute('src')).toBe(urls[0]);

    await act(async () => button('查看第 2 张图片')?.click());
    expect(currentPicture()?.getAttribute('src')).toBe(urls[1]);

    await act(async () => button('上一张图片')?.click());
    expect(currentPicture()?.getAttribute('src')).toBe(urls[0]);
  });
});
