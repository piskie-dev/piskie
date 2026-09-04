import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  ACCOUNT_FAULT_REASONS,
  PiskieFault,
  type AccountClient,
  type PiskieAccountStatus,
  type PiskieUpdateStatus,
  type UpdateClient,
} from '@shared/electron-contracts';
import { AboutDesk } from '../AboutDesk';
import { AccountDesk } from '../AccountDesk';
import { resetAccountStore } from '../../../../store/accountStore';

const NOW = 2_000_000_000_000;
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

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
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('AccountDesk', () => {
  it('uses a page heading and updates the sign-in countdown every second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const waitForSignIn = vi.fn(() => new Promise<PiskieAccountStatus>(() => undefined));
    installPiskie({
      account: accountClient({
        beginSignIn: vi.fn(async () => ({
          flowId: 'flow-1',
          expiresAt: NOW + 10 * 60_000,
        })),
        waitForSignIn,
      }),
    });

    await render(createElement(AccountDesk));
    const heading = container.querySelector('h1');
    expect(heading?.textContent).toBe('Piskie 账户');
    expect(container.querySelector('section')?.getAttribute('aria-labelledby')).toBe(heading?.id);

    await clickButton('登录 Piskie');
    expect(container.querySelector('[role="timer"]')?.textContent).toBe('10:00 后失效');

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.querySelector('[role="timer"]')?.textContent).toBe('09:59 后失效');
    expect(waitForSignIn).toHaveBeenCalledWith('flow-1');
  });

  it('expires and cancels a sign-in when the countdown reaches zero', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cancelSignIn = vi.fn(async () => undefined);
    installPiskie({
      account: accountClient({
        beginSignIn: vi.fn(async () => ({
          flowId: 'flow-expiring',
          expiresAt: NOW + 2_000,
        })),
        waitForSignIn: vi.fn(() => new Promise<PiskieAccountStatus>(() => undefined)),
        cancelSignIn,
      }),
    });

    await render(createElement(AccountDesk));
    await clickButton('登录 Piskie');
    expect(container.querySelector('[role="timer"]')?.textContent).toBe('00:02 后失效');

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.textContent).toContain('登录请求已失效');
    expect(cancelSignIn).toHaveBeenCalledWith('flow-expiring');
  });

  it('presents an account-service deadline as a network failure', async () => {
    installPiskie({
      account: accountClient({
        beginSignIn: vi.fn(async () => {
          throw fault('deadline-exceeded', true);
        }),
      }),
    });

    await render(createElement(AccountDesk));
    await clickButton('登录 Piskie');
    expect(container.textContent).toContain('账户服务暂时无法连接');
    expect(container.textContent).not.toContain('登录请求已失效');
  });

  it('presents a tagged authorization deadline as an expired sign-in', async () => {
    installPiskie({
      account: accountClient({
        beginSignIn: vi.fn(async () => ({
          flowId: 'expired-flow',
          expiresAt: NOW + 60_000,
        })),
        waitForSignIn: vi.fn(async () => {
          throw fault('deadline-exceeded', false, {
            reason: ACCOUNT_FAULT_REASONS.signInExpired,
          });
        }),
      }),
    });

    await render(createElement(AccountDesk));
    await clickButton('登录 Piskie');
    expect(container.textContent).toContain('登录请求已失效');
  });
});

describe('AboutDesk updates', () => {
  it('exposes semantic status and drives check and install actions from observed state', async () => {
    let observe: ((status: PiskieUpdateStatus) => void) | undefined;
    const check = vi.fn(async (): Promise<PiskieUpdateStatus> => ({
      state: 'up-to-date',
      currentVersion: '0.1.0',
      checkedAt: new Date(NOW).toISOString(),
    }));
    const restartAndInstall = vi.fn(async () => true);
    installPiskie({
      updates: updateClient({
        check,
        restartAndInstall,
        observeStatus: vi.fn((listener) => {
          observe = listener;
          return () => undefined;
        }),
      }),
    });

    await render(createElement(AboutDesk));
    expect(container.querySelector('h1')?.textContent).toBe('关于');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('自动检查已启用');

    await clickButton('检查更新');
    expect(check).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('已是最新版本');

    await act(async () => observe?.({
      state: 'downloaded',
      currentVersion: '0.1.0',
      target: { version: '0.2.0' },
    }));
    await clickButton('重启并更新');
    expect(restartAndInstall).toHaveBeenCalledOnce();
  });
});

function accountClient(overrides: Partial<AccountClient> = {}): AccountClient {
  return {
    status: vi.fn(async (): Promise<PiskieAccountStatus> => ({ state: 'signed-out' })),
    beginSignIn: vi.fn(async () => ({ flowId: 'flow', expiresAt: NOW + 10 * 60_000 })),
    waitForSignIn: vi.fn(async (): Promise<PiskieAccountStatus> => ({ state: 'signed-out' })),
    reopenSignIn: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined),
    signOut: vi.fn(async (): Promise<PiskieAccountStatus> => ({ state: 'signed-out' })),
    ...overrides,
  };
}

function updateClient(overrides: Partial<UpdateClient> = {}): UpdateClient {
  return {
    status: vi.fn(async (): Promise<PiskieUpdateStatus> => ({
      state: 'idle',
      currentVersion: '0.1.0',
    })),
    check: vi.fn(async (): Promise<PiskieUpdateStatus> => ({
      state: 'idle',
      currentVersion: '0.1.0',
    })),
    restartAndInstall: vi.fn(async () => true),
    observeStatus: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function installPiskie(options: {
  account?: AccountClient;
  updates?: UpdateClient;
}): void {
  Object.defineProperty(dom.window, 'piskie', {
    configurable: true,
    value: {
      account: options.account ?? accountClient(),
      updates: options.updates ?? updateClient(),
      runtime: { version: '0.1.0' },
    },
  });
}

function fault(
  code: 'deadline-exceeded',
  retryable: boolean,
  details?: Readonly<Record<string, unknown>>,
): PiskieFault {
  return new PiskieFault({
    code,
    correlationId: 'test-correlation',
    message: 'Account operation failed',
    retryable,
    ...(details && { details }),
  });
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
  await flushEffects();
}

async function clickButton(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Button not found: ${label}`);
  await act(async () => button.click());
  await flushEffects();
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
