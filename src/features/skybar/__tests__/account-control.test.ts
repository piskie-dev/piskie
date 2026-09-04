import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type {
  AccountClient,
  PiskieAccountStatus,
} from '@shared/electron-contracts';
import { resetAccountStore } from '../../../store/accountStore';
import { AccountControl } from '../AccountControl';

const NOW = 2_000_000_000_000;
const signedOut: PiskieAccountStatus = { state: 'signed-out' };
const signedIn: PiskieAccountStatus = {
  state: 'signed-in',
  user: {
    id: 'user-1',
    email: 'ada@example.com',
    name: 'Ada',
  },
  connection: 'verified',
  credentialStorage: 'secure',
};

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
  resetAccountStore();
  await i18n.changeLanguage('zh-CN');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  resetAccountStore();
  container.remove();
  vi.useRealTimers();
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

describe('AccountControl', () => {
  it('starts sign-in from the SkyBar and publishes the completed identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let completeSignIn!: (status: PiskieAccountStatus) => void;
    const beginSignIn = vi.fn(async () => ({
      flowId: 'skybar-flow',
      expiresAt: NOW + 60_000,
    }));
    const waitForSignIn = vi.fn(() => new Promise<PiskieAccountStatus>((resolve) => {
      completeSignIn = resolve;
    }));
    installAccount({ beginSignIn, waitForSignIn });

    await render(createElement(MemoryRouter, null, createElement(AccountControl)));
    const trigger = accountTrigger();
    expect(trigger.textContent).toContain('未登录');

    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await clickButton('登录 Piskie');
    expect(beginSignIn).toHaveBeenCalledOnce();
    expect(waitForSignIn).toHaveBeenCalledWith('skybar-flow');
    expect(accountTrigger().textContent).toContain('等待登录');
    expect(container.querySelector('[role="timer"]')?.textContent).toBe('01:00 后失效');

    await act(async () => completeSignIn(signedIn));
    await flushEffects();
    expect(accountTrigger().textContent).toContain('Ada');
    expect(accountTrigger().getAttribute('aria-label')).toContain('已登录：Ada');
  });

  it('shows a signed-in identity and signs out from the SkyBar menu', async () => {
    const signOut = vi.fn(async () => signedOut);
    installAccount({ status: vi.fn(async () => signedIn), signOut });

    await render(createElement(MemoryRouter, null, createElement(AccountControl)));
    expect(accountTrigger().textContent).toContain('Ada');
    expect(container.textContent).toContain('ada@example.com');

    await click(accountTrigger());
    await clickButton('退出登录');
    expect(signOut).toHaveBeenCalledOnce();
    expect(accountTrigger().textContent).toContain('未登录');
  });
});

function installAccount(overrides: Partial<AccountClient> = {}): void {
  const account: AccountClient = {
    status: vi.fn(async () => signedOut),
    beginSignIn: vi.fn(async () => ({ flowId: 'flow', expiresAt: NOW + 60_000 })),
    waitForSignIn: vi.fn(async () => signedIn),
    reopenSignIn: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => signedOut),
    ...overrides,
  };
  Object.defineProperty(dom.window, 'piskie', {
    configurable: true,
    value: { account },
  });
}

function accountTrigger(): HTMLButtonElement {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  if (!trigger) throw new Error('Account trigger not found');
  return trigger;
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element));
  await flushEffects();
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flushEffects();
}

async function clickButton(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Button not found: ${label}`);
  await click(button);
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
