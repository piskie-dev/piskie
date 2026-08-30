import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProxyForge } from '../ProxyForge';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLDialogElement', dom.window.HTMLDialogElement);
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

describe('ProxyForge locale projection', () => {
  it('reprojects an existing validation fault when the locale changes', async () => {
    await act(async () => root.render(createElement(ProxyForge, {
      onClose: vi.fn(),
      onSave: vi.fn(async () => undefined),
    })));

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('保存'))!;
    await act(async () => save.click());
    expect(container.textContent).toContain('请输入代理名称');

    await act(async () => i18n.changeLanguage('en-US'));
    expect(container.textContent).toContain('Enter a proxy name');
    expect(container.textContent).not.toContain('请输入代理名称');

    await act(async () => i18n.changeLanguage('zh-CN'));
    expect(container.textContent).toContain('请输入代理名称');
  });
});
