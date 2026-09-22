import { act, createElement, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import ImageLightbox from '../ImageLightbox';
import {
  mountShortcutListener,
  resetShortcutRegistry,
  useShortcutOwner,
  useShortcutScope,
  type ShortcutScope,
} from '@/shortcuts';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let disposeListener: () => void;

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
  resetShortcutRegistry();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  disposeListener = mountShortcutListener(dom.window as unknown as Window);
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeListener();
  resetShortcutRegistry();
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
    const closeButton = container.querySelector('button[aria-label="关闭预览"]');
    expect(closeButton?.querySelector('svg')).not.toBeNull();
    expect(closeButton?.textContent).toBe('');
  });

  it('pins decoded dimensions so a viewBox-only SVG cannot collapse in the dialog', async () => {
    await act(async () => {
      root.render(createElement(ImageLightbox, {
        preview: { urls: ['piskie-attachment://preview/vector'], index: 0 },
        onClose: vi.fn(),
      }));
    });
    const image = container.querySelector<HTMLImageElement>('img[alt^="第"]')!;
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 200 },
      naturalHeight: { configurable: true, value: 150 },
    });

    await act(async () => image.dispatchEvent(new dom.window.Event('load')));

    expect(image.getAttribute('width')).toBe('200');
    expect(image.getAttribute('height')).toBe('150');
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
    const currentCounter = () => container.querySelector('[aria-label="当前会话中的图片"] [aria-live="polite"]')?.textContent;
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(currentPicture()?.getAttribute('src')).toBe(urls[1]);
    expect(currentCounter()).toBe('2 / 3');

    await act(async () => button('下一张图片')?.click());
    expect(currentPicture()?.getAttribute('src')).toBe(urls[2]);
    expect(currentCounter()).toBe('3 / 3');

    await act(async () => {
      dialog?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
      }));
    });
    expect(currentPicture()?.getAttribute('src')).toBe(urls[0]);
    expect(currentCounter()).toBe('1 / 3');

    await act(async () => button('查看第 2 张图片')?.click());
    expect(currentPicture()?.getAttribute('src')).toBe(urls[1]);
    expect(currentCounter()).toBe('2 / 3');

    await act(async () => button('上一张图片')?.click());
    expect(currentPicture()?.getAttribute('src')).toBe(urls[0]);
    expect(currentCounter()).toBe('1 / 3');
  });

  it('delegates the first Escape to the native dialog and interrupts only on the second', async () => {
    const interrupt = vi.fn();
    const Harness = () => {
      const [preview, setPreview] = useState<{
        readonly urls: readonly string[];
        readonly index: number;
      } | null>({
        urls: ['https://example.test/preview.png'],
        index: 0,
      });
      const scope = useMemo<ShortcutScope>(() => ({
        id: 'test-primary-owner',
        layer: 'active-primary-action',
        blocksLowerLayers: 'none',
        bindings: [{
          id: 'test-primary-owner:interrupt',
          commandId: 'agent.interruptCurrent',
          combo: 'escape',
          enabled: () => true,
          allowInEditable: true,
          handling: 'execute',
          defaultBehavior: 'prevent',
          execute: interrupt,
        }],
      }), []);
      useShortcutScope(scope);
      useShortcutOwner(scope.id);
      return createElement(ImageLightbox, {
        preview,
        onClose: () => setPreview(null),
      });
    };
    await act(async () => root.render(createElement(Harness)));
    const dialog = container.querySelector('dialog')!;
    const first = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    });
    await act(async () => dialog.dispatchEvent(first));
    expect(first.defaultPrevented).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();

    const cancel = new dom.window.Event('cancel', { bubbles: false, cancelable: true });
    await act(async () => dialog.dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();

    const second = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    });
    await act(async () => dom.window.dispatchEvent(second));
    expect(second.defaultPrevented).toBe(true);
    expect(interrupt).toHaveBeenCalledOnce();
  });
});
