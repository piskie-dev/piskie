import { JSDOM, VirtualConsole } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { useUIStore } from '@/store/uiStore';
import { DEFAULT_SETTINGS } from '@shared/constants';
import ErrorBoundary from '../ErrorBoundary';
import { RendererStartupError } from '../RendererStartupError';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let jsdomErrors: string[];

function ThrowError({ message }: { message: string }): never {
  throw new Error(message);
}

beforeAll(() => {
  const virtualConsole = new VirtualConsole();
  jsdomErrors = [];
  virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error.message));
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://piskie.test',
    virtualConsole,
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('SVGElement', dom.window.SVGElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  useUIStore.setState({ settings: null });
  jsdomErrors.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('top-level error surfaces', () => {
  it('leaves a healthy child unchanged', async () => {
    await act(async () => {
      root.render(createElement(ErrorBoundary, null, createElement('p', null, 'ready')));
    });

    expect(container.textContent).toBe('ready');
  });

  it('renders the React failure surface entirely in English', async () => {
    await i18n.changeLanguage('en-US');

    await act(async () => {
      root.render(createElement(
        ErrorBoundary,
        null,
        createElement(ThrowError, { message: 'Render failed' }),
      ));
    });

    expect(container.textContent).toContain('The application encountered an error');
    expect(container.textContent).toContain('Render failed');
    expect(container.textContent).toContain('Reload');
    expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('uses the localized unknown-error copy when an Error has no message', async () => {
    useUIStore.getState().setSettings({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      language: 'zh-CN',
    });

    await act(async () => {
      root.render(createElement(
        ErrorBoundary,
        null,
        createElement(ThrowError, { message: '' }),
      ));
    });

    expect(container.textContent).toContain('应用遇到错误');
    expect(container.textContent).toContain('发生未知错误');
    expect(container.textContent).toContain('重新加载');
  });

  it('reloads the renderer through the recovery action', async () => {
    await act(async () => {
      root.render(createElement(
        ErrorBoundary,
        null,
        createElement(ThrowError, { message: 'boom' }),
      ));
    });

    await act(async () => container.querySelector('button')!.click());

    expect(jsdomErrors.filter((message) => message.includes('Not implemented: navigation')))
      .toHaveLength(1);
  });

  it('defaults the startup failure surface to English before locale is available', async () => {
    await act(async () => {
      root.render(createElement(RendererStartupError, { error: new Error('Runtime offline') }));
    });

    expect(container.textContent).toContain('Runtime unavailable');
    expect(container.textContent).toContain('Renderer startup failed');
    expect(container.textContent).toContain('Runtime offline');
    expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('uses a loaded Chinese locale for a later startup failure', async () => {
    await act(async () => {
      root.render(createElement(RendererStartupError, {
        error: new Error('runtime offline'),
        language: 'zh-CN',
      }));
    });

    expect(container.textContent).toContain('运行时不可用');
    expect(container.textContent).toContain('渲染进程启动失败');
  });
});
