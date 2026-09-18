import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type {
  PiskieUpdateStatus,
  UpdateClient,
} from '@shared/electron-contracts/updates';
import { UpdateIndicator } from '../UpdateIndicator';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let nativeMatches: typeof Element.prototype.matches;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('SVGElement', dom.window.SVGElement);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  nativeMatches = dom.window.Element.prototype.matches;
  Object.defineProperty(dom.window.Element.prototype, 'matches', {
    configurable: true,
    value(this: Element, selector: string): boolean {
      if (selector === ':popover-open') return this.hasAttribute('data-test-popover-open');
      return nativeMatches.call(this, selector);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value(this: HTMLElement): void {
      this.setAttribute('data-test-popover-open', '');
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value(this: HTMLElement): void {
      this.removeAttribute('data-test-popover-open');
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
  vi.restoreAllMocks();
});

afterAll(() => {
  Object.defineProperty(dom.window.Element.prototype, 'matches', {
    configurable: true,
    value: nativeMatches,
  });
  Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'showPopover');
  Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'hidePopover');
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('SkyBar update indicator', () => {
  it('opens a downloaded update confirmation before restarting and installing', async () => {
    const restartAndInstall = vi.fn(async () => true);
    installUpdates({
      state: 'downloaded',
      currentVersion: '0.1.0',
      target: { version: '0.2.0' },
    }, { restartAndInstall });

    await render();
    const trigger = button('新版本');
    expect(trigger.getAttribute('aria-label')).toBe('已有新版本可安装');
    expect(trigger.getAttribute('title')).toBe('已有新版本可安装');

    await click(trigger);
    expect(restartAndInstall).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('版本 0.2.0 已准备好安装。');

    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(restartAndInstall).not.toHaveBeenCalled();

    await click(trigger);
    await click(button('稍后'));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(restartAndInstall).not.toHaveBeenCalled();

    await click(trigger);
    await click(button('重启并更新'));
    expect(restartAndInstall).toHaveBeenCalledOnce();
  });

  it('stays out of the SkyBar for every state except downloaded', async () => {
    const controls = installUpdates({ state: 'idle', currentVersion: '0.1.0' });
    await render();
    expect(findTrigger()).toBeNull();

    const hiddenStates: PiskieUpdateStatus[] = [
      { state: 'checking', currentVersion: '0.1.0' },
      {
        state: 'available',
        currentVersion: '0.1.0',
        target: { version: '0.2.0' },
      },
      {
        state: 'downloading',
        currentVersion: '0.1.0',
        target: { version: '0.2.0' },
        percent: 50,
      },
      {
        state: 'up-to-date',
        currentVersion: '0.1.0',
        checkedAt: '2030-01-01T00:00:00.000Z',
      },
      {
        state: 'error',
        currentVersion: '0.1.0',
        checkedAt: '2030-01-01T00:00:00.000Z',
        error: 'network',
        retryable: true,
      },
    ];
    for (const status of hiddenStates) {
      await act(async () => controls.emit(status));
      expect(findTrigger()).toBeNull();
    }
  });
});

function installUpdates(
  initial: PiskieUpdateStatus,
  overrides: Partial<UpdateClient> = {},
): { emit: (status: PiskieUpdateStatus) => void } {
  let listener: ((status: PiskieUpdateStatus) => void) | undefined;
  const updates: UpdateClient = {
    status: vi.fn(async () => initial),
    check: vi.fn(async () => initial),
    restartAndInstall: vi.fn(async () => true),
    observeStatus: vi.fn((next) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    }),
    ...overrides,
  };
  Object.defineProperty(dom.window, 'piskie', {
    configurable: true,
    value: { updates, runtime: { version: '0.1.0' } },
  });
  return { emit: (status) => listener?.(status) };
}

async function render(): Promise<void> {
  await act(async () => root.render(createElement(UpdateIndicator)));
  await flushEffects();
}

function findTrigger(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="已有新版本可安装"]');
}

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(label));
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flushEffects();
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
