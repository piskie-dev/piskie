import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpControl } from '../cdp-control.js';
import { resolveConfig } from '../config.js';

interface TestableCdpControl {
  send: CdpControl['send'];
  _onMessage(message: unknown): Promise<void>;
}

const proxy = {
  server: 'http://proxy.example:8080',
  username: 'proxy-user',
  password: 'proxy-password',
};

function createControl() {
  const config = resolveConfig('proxy-auth-test', {
    proxy,
    locale: 'zh-CN',
    timezone: 'America/New_York',
    userAgent: 'Test UA',
    geo: { latitude: 40.7128, longitude: -74.006, accuracy: 25 },
  });
  const instance = new CdpControl('ws://unused', config);
  const send = vi.spyOn(instance, 'send').mockResolvedValue({});
  return { control: instance as unknown as TestableCdpControl, send };
}

async function attachPage(control: TestableCdpControl, sessionId: string): Promise<void> {
  await control._onMessage({
    method: 'Target.attachedToTarget',
    params: {
      sessionId,
      targetInfo: { type: 'page', url: 'https://example.com' },
    },
  });
}

describe('CdpControl authenticated proxy events', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('enables auth interception without dropping the existing page overrides, then resumes the target', async () => {
    const { control, send } = createControl();

    await attachPage(control, 'page-1');

    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'Target.setAutoAttach',
      'Emulation.setLocaleOverride',
      'Emulation.setTimezoneOverride',
      'Emulation.setUserAgentOverride',
      'Emulation.setGeolocationOverride',
      'Fetch.enable',
      'Runtime.runIfWaitingForDebugger',
    ]);
    expect(send).toHaveBeenCalledWith('Fetch.enable', { handleAuthRequests: true }, 'page-1');
    expect(send.mock.calls.every(([, , sessionId]) => sessionId === 'page-1')).toBe(true);
  });

  it('uses native unavailable geolocation when the runtime blocks location', async () => {
    const config = resolveConfig('geo-block-test', {
      proxy,
      blockGeolocation: true,
      geo: { latitude: 40.7128, longitude: -74.006, accuracy: 25 },
    });
    const instance = new CdpControl('ws://unused', config);
    const send = vi.spyOn(instance, 'send').mockResolvedValue({});

    await attachPage(instance as unknown as TestableCdpControl, 'page-1');

    expect(send).toHaveBeenCalledWith('Emulation.setGeolocationOverride', {}, 'page-1');
    expect(send).not.toHaveBeenCalledWith(
      'Emulation.setGeolocationOverride',
      expect.objectContaining({ latitude: expect.any(Number) }),
      'page-1',
    );
  });

  it('uses the worker-supported Network domain for custom UA', async () => {
    const { control, send } = createControl();

    await control._onMessage({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'worker-1',
        targetInfo: { type: 'service_worker', url: 'https://example.com/worker.js' },
      },
    });

    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'Target.setAutoAttach',
      'Emulation.setLocaleOverride',
      'Emulation.setTimezoneOverride',
      'Network.setUserAgentOverride',
      'Runtime.runIfWaitingForDebugger',
    ]);
  });

  it('provides credentials once per request and cancels a repeated challenge in the same session', async () => {
    const { control, send } = createControl();
    await attachPage(control, 'page-1');
    send.mockClear();

    const challenge = {
      method: 'Fetch.authRequired',
      sessionId: 'page-1',
      params: { requestId: 'request-1', authChallenge: { source: 'Proxy' } },
    };
    await control._onMessage(challenge);
    await control._onMessage(challenge);

    expect(send).toHaveBeenNthCalledWith(
      1,
      'Fetch.continueWithAuth',
      {
        requestId: 'request-1',
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: 'proxy-user',
          password: 'proxy-password',
        },
      },
      'page-1',
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      'Fetch.continueWithAuth',
      {
        requestId: 'request-1',
        authChallengeResponse: { response: 'CancelAuth' },
      },
      'page-1',
    );
  });

  it('scopes auth attempts to the flattened CDP session', async () => {
    const { control, send } = createControl();
    await attachPage(control, 'page-1');
    await attachPage(control, 'page-2');
    send.mockClear();

    for (const sessionId of ['page-1', 'page-2']) {
      await control._onMessage({
        method: 'Fetch.authRequired',
        sessionId,
        params: { requestId: 'same-request-id', authChallenge: { source: 'Proxy' } },
      });
    }

    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expect(call[1]).toMatchObject({
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: 'proxy-user',
          password: 'proxy-password',
        },
      });
    }
    expect(send.mock.calls.map(([, , sessionId]) => sessionId)).toEqual(['page-1', 'page-2']);
  });

  it('continues every paused request so Fetch.enable cannot stall ordinary navigation', async () => {
    const { control, send } = createControl();

    await control._onMessage({
      method: 'Fetch.requestPaused',
      sessionId: 'page-1',
      params: { requestId: 'request-1' },
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      'Fetch.continueRequest',
      { requestId: 'request-1' },
      'page-1',
    );
  });

  it('uses Default for origin-server auth instead of leaking proxy credentials', async () => {
    const { control, send } = createControl();
    await attachPage(control, 'page-1');
    send.mockClear();

    await control._onMessage({
      method: 'Fetch.authRequired',
      sessionId: 'page-1',
      params: { requestId: 'request-1', authChallenge: { source: 'Server' } },
    });

    expect(send).toHaveBeenCalledWith(
      'Fetch.continueWithAuth',
      {
        requestId: 'request-1',
        authChallengeResponse: { response: 'Default' },
      },
      'page-1',
    );
  });

  it('always resumes a target when an optional override fails', async () => {
    const { control, send } = createControl();
    send.mockImplementation(async (method) => {
      if (method === 'Fetch.enable') {
        throw new Error(`${method} failed`);
      }
      return {};
    });

    await expect(attachPage(control, 'page-1')).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledWith('Fetch.enable', { handleAuthRequests: true }, 'page-1');
    expect(send).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'page-1');
  });

  it('swallows Fetch event response failures and clears auth state after detach', async () => {
    const { control, send } = createControl();
    await attachPage(control, 'page-1');
    send.mockRejectedValue(new Error('session closed'));

    await expect(control._onMessage({
      method: 'Fetch.requestPaused',
      sessionId: 'page-1',
      params: { requestId: 'request-1' },
    })).resolves.toBeUndefined();
    await expect(control._onMessage({
      method: 'Fetch.authRequired',
      sessionId: 'page-1',
      params: { requestId: 'request-1', authChallenge: { source: 'Proxy' } },
    })).resolves.toBeUndefined();

    send.mockResolvedValue({});
    await control._onMessage({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'page-1' },
    });
    await control._onMessage({
      method: 'Fetch.authRequired',
      sessionId: 'page-1',
      params: { requestId: 'request-2', authChallenge: { source: 'Proxy' } },
    });

    expect(send).toHaveBeenLastCalledWith(
      'Fetch.continueWithAuth',
      {
        requestId: 'request-2',
        authChallengeResponse: { response: 'CancelAuth' },
      },
      'page-1',
    );
  });
});
