import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-qr-test-'));
process.env.OPENCLAW_STATE_DIR = stateDir;

import {
  cancelWeixinLogin,
  startWeixinLoginWithQr,
  submitWeixinLoginVerifyCode,
  waitForWeixinLogin,
} from '../vendor/src/auth/login-qr.js';
import { weixinPlugin } from '../vendor/src/channel.js';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: vi.fn(async () => JSON.stringify(body)),
  } as unknown as Response;
}

function saveAccount(accountId: string, token: string): void {
  const dir = path.join(stateDir, 'openclaw-weixin', 'accounts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${accountId}.json`), JSON.stringify({ token }), 'utf8');
}

const sessions: string[] = [];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const session of sessions.splice(0)) cancelWeixinLogin(session);
  vi.unstubAllGlobals();
});

describe('Weixin GUI QR state machine', () => {
  it('sends no unrelated local tokens for a new Bot and only the bound token for re-login', async () => {
    saveAccount('other-im-bot', 'other-token');
    saveAccount('known-im-bot', 'known-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: 'q1', qrcode_img_content: 'url-1' }))
      .mockResolvedValueOnce(response({ qrcode: 'q2', qrcode_img_content: 'url-2' }));
    vi.stubGlobal('fetch', fetchMock);

    sessions.push('new-session', 'known-session');
    await startWeixinLoginWithQr({ accountId: 'new-session', force: true });
    await startWeixinLoginWithQr({
      accountId: 'known-session',
      localAccountId: 'known-im-bot',
      force: true,
    });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(firstBody.local_token_list).toEqual([]);
    expect(secondBody.local_token_list).toEqual(['known-token']);
  });

  it('returns need_verify_code without stdin, accepts a code, then completes login', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: 'q-verify', qrcode_img_content: 'url-verify' }))
      .mockResolvedValueOnce(response({ status: 'need_verifycode' }))
      .mockResolvedValueOnce(response({
        status: 'confirmed',
        ilink_bot_id: 'real@im.bot',
        bot_token: 'bot-token',
        ilink_user_id: 'user@im.wechat',
      }));
    vi.stubGlobal('fetch', fetchMock);
    sessions.push('verify-session');

    await startWeixinLoginWithQr({ accountId: 'verify-session', force: true });
    await expect(waitForWeixinLogin({ sessionKey: 'verify-session', timeoutMs: 1000 }))
      .resolves.toMatchObject({ connected: false, state: 'need_verify_code' });
    expect(submitWeixinLoginVerifyCode('verify-session', '12ab')).toMatchObject({ accepted: false });
    expect(submitWeixinLoginVerifyCode('verify-session', '1234')).toMatchObject({ accepted: true });
    await expect(waitForWeixinLogin({ sessionKey: 'verify-session', timeoutMs: 1000 }))
      .resolves.toMatchObject({ connected: true, state: 'connected', accountId: 'real@im.bot' });

    expect(String(fetchMock.mock.calls[2][0])).toContain('verify_code=1234');
  });

  it('cancels the active long poll and deletes the session', async () => {
    let pollSignal: AbortSignal | undefined;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: 'q-cancel', qrcode_img_content: 'url-cancel' }))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        pollSignal = init.signal as AbortSignal;
        pollSignal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    sessions.push('cancel-session');

    await startWeixinLoginWithQr({ accountId: 'cancel-session', force: true });
    const waiting = waitForWeixinLogin({ sessionKey: 'cancel-session', timeoutMs: 10_000 });
    await vi.waitFor(() => expect(pollSignal).toBeDefined());
    expect(cancelWeixinLogin('cancel-session')).toMatchObject({ cancelled: true });
    await expect(waiting).resolves.toMatchObject({ connected: false, state: 'error' });
    expect(pollSignal?.aborted).toBe(true);
    await expect(waitForWeixinLogin({ sessionKey: 'cancel-session', timeoutMs: 1000 }))
      .resolves.toMatchObject({ state: 'expired' });
  });

  it('cancels an in-flight QR creation before it can leave an orphan session', async () => {
    let startSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      startSignal = init.signal as AbortSignal;
      startSignal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })));
    sessions.push('cancel-start');

    const starting = startWeixinLoginWithQr({ accountId: 'cancel-start', force: true });
    await vi.waitFor(() => expect(startSignal).toBeDefined());
    expect(cancelWeixinLogin('cancel-start')).toMatchObject({ cancelled: true });
    await expect(starting).resolves.toMatchObject({ message: '登录已取消。' });
    expect(startSignal?.aborted).toBe(true);
    await expect(waitForWeixinLogin({ sessionKey: 'cancel-start', timeoutMs: 1000 }))
      .resolves.toMatchObject({ state: 'expired' });
  });

  it('returns already_connected only when the explicitly bound local credential exists', async () => {
    saveAccount('bound-im-bot', 'bound-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: 'q-bound', qrcode_img_content: 'url-bound' }))
      .mockResolvedValueOnce(response({ status: 'binded_redirect' }));
    vi.stubGlobal('fetch', fetchMock);
    sessions.push('bound-session');

    await startWeixinLoginWithQr({
      accountId: 'bound-session',
      localAccountId: 'bound-im-bot',
      force: true,
    });
    await expect(waitForWeixinLogin({ sessionKey: 'bound-session', timeoutMs: 1000 }))
      .resolves.toMatchObject({
        connected: false,
        state: 'already_connected',
        alreadyConnected: true,
        accountId: 'bound-im-bot',
      });
  });

  it('normalizes alreadyConnected into a successful channel result for the known Bot account', async () => {
    saveAccount('known-im-bot', 'known-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: 'q-known', qrcode_img_content: 'url-known' }))
      .mockResolvedValueOnce(response({ status: 'binded_redirect' }));
    vi.stubGlobal('fetch', fetchMock);
    sessions.push('known-bot-session');

    await weixinPlugin.gateway.loginWithQrStart({
      accountId: 'known-bot-session',
      credentialAccountId: 'known@im.bot',
      force: true,
    });
    await expect(weixinPlugin.gateway.loginWithQrWait({
      accountId: 'known-bot-session',
      credentialAccountId: 'known@im.bot',
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      connected: true,
      state: 'already_connected',
      alreadyConnected: true,
      accountId: 'known@im.bot',
    });
  });
});
