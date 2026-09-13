import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  loginWithQrStart: vi.fn(), loginWithQrWait: vi.fn(),
  loginWithQrSubmitCode: vi.fn(), loginWithQrCancel: vi.fn(),
}));
vi.mock('../../../store/messagingStore', () => ({
  useMessagingStore: (select: (state: typeof actions) => unknown) => select(actions),
}));
import { WeixinQrFlow } from '../WeixinQrFlow';

let root: Root;
let container: HTMLDivElement;
let dom: JSDOM;
const loginLink = 'https://liteapp.weixin.qq.com/?qrcode=test-login&bot_type=3';

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.resetAllMocks();
  actions.loginWithQrStart.mockResolvedValue({ qrDataUrl: loginLink, message: 'Scan to connect' });
  actions.loginWithQrWait.mockImplementation(() => new Promise(() => {}));
  actions.loginWithQrCancel.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(StrictMode, null, createElement(WeixinQrFlow, {
    botId: 'bot-1', channelType: 'openclaw-weixin', force: false,
    onConnected: vi.fn(), onDismiss: vi.fn(),
  }))));
  await act(async () => vi.advanceTimersByTimeAsync(0));
}

describe('Weixin QR login', () => {
  it('encodes a login link into an accessible QR without fetching it as an image', async () => {
    await render();
    const qr = container.querySelector('svg[role="img"]');
    expect(qr?.getAttribute('aria-label')).toBeTruthy();
    expect(qr?.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain(loginLink);
  });

  it('starts only one login under StrictMode and cancels it when closed', async () => {
    await render();
    expect(actions.loginWithQrStart).toHaveBeenCalledTimes(1);
    expect(actions.loginWithQrWait).toHaveBeenCalledTimes(1);
    expect(actions.loginWithQrCancel).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(actions.loginWithQrCancel).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'error', 'verify_code_blocked'])('allows a fresh login after %s', async (state) => {
    actions.loginWithQrWait.mockResolvedValueOnce({ connected: false, state, message: 'Try again' });
    await render();
    const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === '重新生成登录码');
    expect(refresh).toBeDefined();
    await act(async () => refresh!.click());
    expect(actions.loginWithQrStart).toHaveBeenLastCalledWith('bot-1', 'openclaw-weixin', true);
    expect(actions.loginWithQrCancel).toHaveBeenCalledTimes(1);
  });
});
