/**
 * 覆盖注入用的原生 CDP 控制通道。
 * 用 flatten auto-attach + waitForDebuggerOnStart，让每个 target 在脚本执行前暂停，
 * 应用 locale/timezone/UA/geo/proxy-auth 后再放行。这里不向页面注入 JavaScript。
 */
import WebSocket from 'ws';
import type { FpConfig } from './config.js';

interface Pending {
  res: (value: unknown) => void;
  rej: (error: Error) => void;
}

interface ProxyAuthState {
  username: string;
  password: string;
  attemptedRequestIds: Set<string>;
}

export class CdpControl {
  private url: string;
  private cfg: FpConfig;
  private _id = 0;
  private _pending = new Map<number, Pending>();
  private _proxyAuthBySession = new Map<string, ProxyAuthState>();
  private _closed = false;
  private ws!: WebSocket;

  constructor(browserWsUrl: string, cfg: FpConfig) {
    this.url = browserWsUrl;
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url, {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data: WebSocket.RawData) => {
      void this._onMessage(JSON.parse(data.toString())).catch(() => {});
    });
    this.ws.on('close', () => {
      this._closed = true;
    });
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (this._closed) return Promise.reject(new Error('cdp closed'));
    const id = ++this._id;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((res, rej) => {
      this._pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(message));
      setTimeout(() => {
        if (this._pending.delete(id)) rej(new Error(`timeout ${method}`));
      }, 8000);
    });
  }

  private async _onMessage(message: any): Promise<void> {
    if (message.id && this._pending.has(message.id)) {
      const { res, rej } = this._pending.get(message.id)!;
      this._pending.delete(message.id);
      return message.error ? rej(new Error(message.error.message)) : res(message.result);
    }

    if (message.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = message.params;
      this._proxyAuthBySession.delete(sessionId);
      if (process.env.FPB_DEBUG) {
        console.error(
          `[cdp] attached type=${targetInfo.type} url=${(targetInfo.url || '').slice(0, 40)}`,
        );
      }
      await this._injectAndResume(sessionId, targetInfo.type);
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      this._proxyAuthBySession.delete(message.params?.sessionId);
      return;
    }
    if (message.method === 'Fetch.authRequired' && message.sessionId) {
      await this._handleAuthRequired(message.sessionId, message.params);
      return;
    }
    if (message.method === 'Fetch.requestPaused' && message.sessionId) {
      const requestId = message.params?.requestId;
      if (requestId) {
        await this.send(
          'Fetch.continueRequest',
          { requestId },
          message.sessionId,
        ).catch(() => {});
      }
    }
  }

  private async _handleAuthRequired(
    sessionId: string,
    params: { requestId?: string; authChallenge?: { source?: string } },
  ): Promise<void> {
    const requestId = params?.requestId;
    if (!requestId) return;

    const state = this._proxyAuthBySession.get(sessionId);
    const isProxyChallenge = params.authChallenge?.source === 'Proxy';
    let authChallengeResponse: Record<string, string>;
    if (!isProxyChallenge) {
      authChallengeResponse = { response: 'Default' };
    } else if (!state || state.attemptedRequestIds.has(requestId)) {
      authChallengeResponse = { response: 'CancelAuth' };
    } else {
      state.attemptedRequestIds.add(requestId);
      authChallengeResponse = {
        response: 'ProvideCredentials',
        username: state.username,
        password: state.password,
      };
    }

    await this.send(
      'Fetch.continueWithAuth',
      { requestId, authChallengeResponse },
      sessionId,
    ).catch(() => {});
  }

  private async _injectAndResume(sessionId: string, type: string): Promise<void> {
    const send = (method: string, params: Record<string, unknown>) =>
      this.send(method, params, sessionId).catch(() => {});
    const isPage = type === 'page' || type === 'iframe';
    const isWorker = /worker/i.test(type);

    try {
      await send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      if ((isPage || isWorker) && this.cfg.locale) {
        await send('Emulation.setLocaleOverride', { locale: this.cfg.locale });
      }
      if ((isPage || isWorker) && this.cfg.timezone) {
        await send('Emulation.setTimezoneOverride', { timezoneId: this.cfg.timezone });
      }
      if (isPage && this.cfg.userAgent) {
        await send('Emulation.setUserAgentOverride', {
          userAgent: this.cfg.userAgent,
          acceptLanguage: this.cfg.acceptLanguage,
          userAgentMetadata: this.cfg.userAgentMetadata,
        });
      }
      if (isWorker && this.cfg.userAgent) {
        await send('Network.setUserAgentOverride', {
          userAgent: this.cfg.userAgent,
          acceptLanguage: this.cfg.acceptLanguage,
          userAgentMetadata: this.cfg.userAgentMetadata,
        });
      }
      if (isPage && this.cfg.blockGeolocation) {
        await send('Emulation.setGeolocationOverride', {});
      } else if (isPage && this.cfg.geo) {
        await send('Emulation.setGeolocationOverride', {
          latitude: this.cfg.geo.latitude,
          longitude: this.cfg.geo.longitude,
          accuracy: this.cfg.geo.accuracy ?? 50,
        });
      }
      if (
        isPage &&
        this.cfg.proxy &&
        typeof this.cfg.proxy !== 'string' &&
        this.cfg.proxy.username
      ) {
        this._proxyAuthBySession.set(sessionId, {
          username: this.cfg.proxy.username,
          password: this.cfg.proxy.password ?? '',
          attemptedRequestIds: new Set(),
        });
        await send('Fetch.enable', { handleAuthRequests: true });
      }
    } finally {
      await send('Runtime.runIfWaitingForDebugger', {});
    }
  }

  close(): void {
    this._closed = true;
    this._proxyAuthBySession.clear();
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
