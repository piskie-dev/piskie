const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
  });
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement'] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name],
    });
  }
  return dom;
});

import i18n from 'i18next';
import { act, createElement, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import KernelDownloadIndicator from '../KernelDownloadIndicator';

vi.mock('framer-motion', async () => {
  const { createElement } = await import('react');
  const element = (tag: 'div' | 'span') => ({
    initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props
  }: Record<string, unknown>) => createElement(tag, props);
  return {
    AnimatePresence: ({ children }: PropsWithChildren) => children,
    motion: { div: element('div'), span: element('span') },
  };
});

type EnvironmentsApi = Window['piskie']['pilot']['environments'];
type KernelStatus = Awaited<ReturnType<EnvironmentsApi['kernelStatus']>>;
type KernelProgress = NonNullable<KernelStatus['progress']>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const failedStatus: KernelStatus = {
  hostKey: 'sample-platform',
  installed: false,
  hasAsset: true,
  version: 'fpc-0.0.0',
  progress: { hostKey: 'sample-platform', phase: 'error', message: 'Sample previous failure' },
};
const readyStatus: KernelStatus = {
  hostKey: 'sample-platform', installed: true, hasAsset: true, version: 'fpc-0.0.0',
};
const kernelStatus = vi.fn<EnvironmentsApi['kernelStatus']>();
const installKernel = vi.fn<EnvironmentsApi['installKernel']>();
const unsubscribe = vi.fn();
let observe: (progress: KernelProgress) => void;
let response: ReturnType<typeof deferred<KernelStatus>>;
let root: Root;
let container: HTMLDivElement;
let router: ReturnType<typeof createMemoryRouter>;

function retryButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent === i18n.t('browserRuntime.retryDownload'));
}

function settingsButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('button[aria-label]')!;
}

async function render() {
  await act(async () => root.render(createElement(RouterProvider, { router })));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  await i18n.changeLanguage('zh-CN');
  response = deferred<KernelStatus>();
  kernelStatus.mockReset().mockResolvedValue(failedStatus);
  installKernel.mockReset().mockReturnValue(response.promise);
  unsubscribe.mockReset();
  Object.defineProperty(window, 'piskie', { configurable: true, value: {
    pilot: { environments: {
      kernelStatus,
      installKernel,
      observeKernel: (listener: typeof observe) => {
        observe = listener;
        return unsubscribe;
      },
    } },
  } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  router = createMemoryRouter([
    { path: '*', element: createElement(KernelDownloadIndicator) },
  ], { initialEntries: ['/console'] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  router.dispose();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await i18n.changeLanguage('zh-CN');
});

afterAll(() => testDOM.window.close());

describe('KernelDownloadIndicator retry', () => {
  it.each([
    ['zh-CN', '重新下载'],
    ['en-US', 'Download again'],
  ])('keeps accessible retry and settings buttons separate in %s', async (language, label) => {
    await i18n.changeLanguage(language);
    await render();

    const retry = retryButton()!;
    const settings = settingsButton();
    expect(retry.textContent).toBe(label);
    expect(retry.type).toBe('button');
    expect(retry.disabled).toBe(false);
    expect(retry.tabIndex).toBe(0);
    expect(settings.getAttribute('aria-label')).toContain(i18n.t('browserRuntime.viewDetails'));
    expect(settings.parentElement).toBe(retry.closest('.h-9'));
    expect(settings.parentElement?.classList).toContain('h-9');
    expect(settings.parentElement?.classList).toContain('w-[230px]');
    expect(settings.parentElement?.classList).toContain('rounded-xl');
    expect(settings.classList).toContain('w-full');
    expect(settings.classList).toContain('absolute');
    expect(retry.classList).toContain('inline');
    expect(retry.classList).toContain('underline');
    expect(retry.classList).not.toContain('border-l');
    expect(settings.querySelector('button')).toBeNull();
    expect(retry.querySelector('button')).toBeNull();
    expect(container.textContent).toContain(
      i18n.t('browserRuntime.retryPrompt') + i18n.t('browserRuntime.retryDownload'),
    );
    act(() => retry.focus());
    expect(document.activeElement).toBe(retry);

    await act(async () => settings.click());
    expect(router.state.location.pathname + router.state.location.search).toBe('/preferences?sect=kernel');
    expect(installKernel).not.toHaveBeenCalled();
  });

  it('clears the old failure immediately and starts only one download on repeated clicks', async () => {
    await render();
    expect(settingsButton().title).toBe('Sample previous failure');
    const retry = retryButton()!;

    act(() => {
      retry.click();
      retry.click();
    });

    expect(installKernel).toHaveBeenCalledExactlyOnceWith();
    expect(router.state.location.pathname).toBe('/console');
    expect(container.textContent).toContain(i18n.t('browserRuntime.preparing'));
    expect(container.textContent).not.toContain(i18n.t('browserRuntime.installFailed'));
    expect(container.textContent).not.toContain(i18n.t('browserRuntime.retryPrompt'));
    expect(settingsButton().title).toBe(i18n.t('browserRuntime.preparing'));
    expect(retryButton()).toBeUndefined();

    act(() => observe({ hostKey: 'sample-platform', phase: 'download', received: 1_000_000, total: 4_000_000 }));
    expect(container.textContent).toContain(i18n.t('browserRuntime.downloadingPercent', { percent: 25 }));
    expect(container.textContent).toContain('1.0 MB / 4.0 MB');
    expect(retryButton()).toBeUndefined();
    expect(installKernel).toHaveBeenCalledOnce();
  });

  it('shows the new observed failure and waits for the pending attempt before allowing another retry', async () => {
    await render();
    act(() => retryButton()!.click());
    act(() => observe({ hostKey: 'sample-platform', phase: 'error', message: 'Sample new download failure' }));

    expect(container.textContent).toContain(i18n.t('browserRuntime.installFailed'));
    expect(settingsButton().title).toBe('Sample new download failure');
    expect(retryButton()!.disabled).toBe(true);
    act(() => retryButton()!.click());
    expect(installKernel).toHaveBeenCalledOnce();

    await act(async () => response.reject(new Error('Sample installation request failed')));
    expect(settingsButton().title).toBe('Sample new download failure');
    expect(retryButton()!.disabled).toBe(false);

    const secondResponse = deferred<KernelStatus>();
    installKernel.mockReturnValueOnce(secondResponse.promise);
    act(() => retryButton()!.click());
    expect(installKernel).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(i18n.t('browserRuntime.preparing'));
    expect(settingsButton().title).not.toContain('Sample new download failure');
    await act(async () => secondResponse.resolve(readyStatus));
  });

  it('shows a fresh request error even when no error progress event arrives', async () => {
    await render();
    act(() => retryButton()!.click());
    await act(async () => response.reject(new Error('Sample retry request failure')));

    expect(container.textContent).toContain(i18n.t('browserRuntime.installFailed'));
    expect(container.textContent).toContain(
      i18n.t('browserRuntime.retryPrompt') + i18n.t('browserRuntime.retryDownload'),
    );
    expect(settingsButton().title).toBe('Sample retry request failure');
    expect(retryButton()!.disabled).toBe(false);
    expect(installKernel).toHaveBeenCalledOnce();
  });

  it.each([true, false])('keeps the ready indication and its dismissal after success (done event: %s)', async (withDoneEvent) => {
    await render();
    act(() => retryButton()!.click());
    kernelStatus.mockResolvedValue(readyStatus);
    if (withDoneEvent) {
      await act(async () => observe({ hostKey: 'sample-platform', phase: 'done' }));
    }
    await act(async () => response.resolve(readyStatus));

    expect(container.textContent).toContain(i18n.t('browserRuntime.installDone'));
    expect(container.textContent).toContain('0.0.0');
    expect(retryButton()).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(container.textContent).toBe('');
  });

  it('retains the settings entry for an unavailable platform', async () => {
    kernelStatus.mockResolvedValue({ ...failedStatus, hasAsset: false });
    await render();

    expect(container.textContent).toContain(i18n.t('browserRuntime.unavailable'));
    expect(retryButton()).toBeUndefined();
    await act(async () => settingsButton().click());
    expect(router.state.location.pathname + router.state.location.search).toBe('/preferences?sect=kernel');
    expect(installKernel).not.toHaveBeenCalled();
  });
});
