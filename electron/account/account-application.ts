import { createHash, randomBytes } from 'node:crypto';
import { createUuid } from '@shared/utils/identifiers.js';
import { z } from 'zod';

import {
  ACCOUNT_FAULT_REASONS,
  type PiskieAccountSignInChallenge,
  type PiskieAccountStatus,
  type PiskieAccountUser,
} from '../../shared/electron-contracts/account.js';
import { PublicOperationError } from '../capabilities/public-errors.js';
import { appLog } from '../observability/logging/app-log.js';
import type {
  AccountCredential,
  AccountCredentialRecord,
  AccountCredentialVault,
} from './credential-store.js';
import {
  startOAuthLoopbackListener,
  type OAuthLoopbackListener,
  type OAuthLoopbackListenerFactory,
} from './oauth-loopback.js';

const CLIENT_ID = 'piskie-desktop';
const AUTHORIZATION_LIFETIME_MS = 10 * 60_000;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SCOPES = 'openid profile email offline_access';

const tokenSchema = z.object({
  access_token: z.string().min(16).max(16_384),
  refresh_token: z.string().min(16).max(16_384),
  token_type: z.string().max(32),
  expires_in: z.number().int().min(1).max(60 * 60 * 24 * 90),
  scope: z.string().max(4_096).optional(),
});
const userInfoSchema = z.object({
  sub: z.string().min(1).max(512),
  email: z.string().email().max(320),
  name: z.string().max(512).optional(),
  picture: z.string().url().max(8_192).nullable().optional(),
});
const protocolErrorSchema = z.object({
  error: z.string().max(128),
  error_description: z.string().max(1_024).optional(),
});

interface SignInFlow {
  readonly id: string;
  readonly startedAt: number;
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly expiresAt: number;
  readonly listener: OAuthLoopbackListener;
  readonly controller: AbortController;
  waiting: boolean;
}

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type SignInStage =
  | 'callback-listen'
  | 'browser-open'
  | 'callback-wait'
  | 'token-exchange'
  | 'userinfo'
  | 'credential-save';

type SignInFailureKind =
  | 'listener-unavailable'
  | 'invalid-redirect'
  | 'browser-open-failed'
  | 'callback-failed'
  | 'authorization-failed'
  | 'authorization-expired'
  | 'http-error'
  | 'invalid-response'
  | 'network-error'
  | 'request-timeout'
  | 'credential-save-failed';

interface RequestDiagnostics {
  failureKind: SignInFailureKind;
  requestPath?: string;
  httpStatus?: number;
  systemErrorCode?: string;
}

interface SignInDiagnostics extends RequestDiagnostics {
  stage: SignInStage;
  startedAt: number;
}

export class AccountApplication {
  private readonly baseUrl: URL;
  private readonly issuer: string;
  private readonly flows = new Map<string, SignInFlow>();
  private refreshInFlight?: Promise<AccountCredentialRecord | null>;

  constructor(private readonly dependencies: {
    baseUrl: string;
    credentials: AccountCredentialVault;
    openExternal(url: string): Promise<void>;
    fetch?: FetchPort;
    listenForOAuthCallback?: OAuthLoopbackListenerFactory;
    now?: () => number;
    randomSecret?: () => string;
  }) {
    this.baseUrl = new URL(dependencies.baseUrl);
    this.issuer = new URL('/api/auth', this.baseUrl).toString().replace(/\/$/, '');
  }

  async status(signal?: AbortSignal): Promise<PiskieAccountStatus> {
    const stored = await this.dependencies.credentials.load();
    if (!stored) return { state: 'signed-out' };
    if (stored.credential.refreshTokenExpiresAt <= this.now()) {
      await this.dependencies.credentials.clear();
      return { state: 'signed-out' };
    }

    try {
      let record = stored;
      if (record.credential.accessTokenExpiresAt <= this.now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
        const refreshed = await this.refreshCredential(record, signal);
        if (!refreshed) return { state: 'signed-out' };
        record = refreshed;
      }

      let user = await this.userInfo(record.credential.accessToken, signal);
      if (!user) {
        const refreshed = await this.refreshCredential(record, signal);
        if (!refreshed) return { state: 'signed-out' };
        record = refreshed;
        user = await this.userInfo(record.credential.accessToken, signal);
      }

      if (!user) {
        await this.dependencies.credentials.clear();
        return { state: 'signed-out' };
      }

      if (!sameUser(user, record.credential.user)) {
        record = await this.dependencies.credentials.save({
          ...record.credential,
          user,
        });
      }
      return signedIn(user, record.storage, 'verified');
    } catch (error) {
      if (signal?.aborted) throw error;
      return signedIn(stored.credential.user, stored.storage, 'offline');
    }
  }

  async beginSignIn(signal?: AbortSignal): Promise<PiskieAccountSignInChallenge> {
    this.cancelAllFlows();
    if (signal?.aborted) throw abortError();

    const attempt = { id: createUuid(), startedAt: this.now() };
    const state = this.randomSecret();
    const codeVerifier = this.randomSecret();
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const nonce = this.randomSecret();
    const expiresAt = this.now() + AUTHORIZATION_LIFETIME_MS;
    let listener: OAuthLoopbackListener;

    try {
      listener = await (
        this.dependencies.listenForOAuthCallback ?? startOAuthLoopbackListener
      )({
        expectedIssuer: this.issuer,
        expectedState: state,
        timeoutMs: AUTHORIZATION_LIFETIME_MS,
      });
    } catch (error) {
      if (!signal?.aborted) {
        this.logSignInFailure(attempt, {
          stage: 'callback-listen',
          startedAt: attempt.startedAt,
          failureKind: 'listener-unavailable',
        }, error);
      }
      throw new PublicOperationError(
        'unavailable',
        'Piskie could not open a local OAuth callback port',
      );
    }

    if (!isAllowedLoopbackRedirect(listener.redirectUri)) {
      listener.close();
      if (!signal?.aborted) {
        this.logSignInFailure(attempt, {
          stage: 'callback-listen',
          startedAt: attempt.startedAt,
          failureKind: 'invalid-redirect',
        });
      }
      throw new PublicOperationError(
        'unavailable',
        'Piskie received an invalid local OAuth callback address',
      );
    }

    const authorizationUrl = new URL('/api/auth/oauth2/authorize', this.baseUrl);
    authorizationUrl.search = new URLSearchParams({
      client_id: CLIENT_ID,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      nonce,
      prompt: 'consent',
      redirect_uri: listener.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      state,
    }).toString();
    const flow: SignInFlow = {
      ...attempt,
      authorizationUrl: authorizationUrl.toString(),
      codeVerifier,
      expiresAt,
      listener,
      controller: new AbortController(),
      waiting: false,
    };
    this.flows.set(flow.id, flow);

    const browserStartedAt = this.now();
    try {
      await this.dependencies.openExternal(flow.authorizationUrl);
    } catch (error) {
      if (!signal?.aborted && !flow.controller.signal.aborted) {
        this.logSignInFailure(flow, {
          stage: 'browser-open',
          startedAt: browserStartedAt,
          failureKind: 'browser-open-failed',
        }, error);
      }
      this.cancelSignIn(flow.id);
      throw error;
    }

    return Object.freeze({ flowId: flow.id, expiresAt: flow.expiresAt });
  }

  async waitForSignIn(flowId: string, signal: AbortSignal): Promise<PiskieAccountStatus> {
    const flow = this.requireFlow(flowId);
    if (signal.aborted) {
      this.cancelSignIn(flowId);
      throw abortError();
    }
    if (flow.waiting) {
      throw new PublicOperationError('conflict', 'This account sign-in is already being watched');
    }
    flow.waiting = true;
    const abort = (): void => flow.controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let diagnostics: SignInDiagnostics = {
      stage: 'callback-wait',
      startedAt: this.now(),
      failureKind: 'callback-failed',
    };
    let denied = false;

    try {
      const callback = await flow.listener.wait(flow.controller.signal);
      if ('error' in callback) {
        if (callback.error === 'access_denied') {
          denied = true;
          throw new PublicOperationError('forbidden', 'The account sign-in was denied');
        }
        if (callback.error === 'expired') {
          diagnostics.failureKind = 'authorization-expired';
          throw signInExpired();
        }
        diagnostics.failureKind = callback.error === 'callback_failed'
          ? 'callback-failed'
          : 'authorization-failed';
        throw new PublicOperationError(
          'unavailable',
          callback.errorDescription ?? 'The OAuth authorization failed',
        );
      }

      diagnostics = {
        stage: 'token-exchange',
        startedAt: this.now(),
        failureKind: 'invalid-response',
      };
      const exchange = await this.request('/api/auth/oauth2/token', {
        method: 'POST',
        form: {
          client_id: CLIENT_ID,
          code: callback.code,
          code_verifier: flow.codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: flow.listener.redirectUri,
        },
        signal: flow.controller.signal,
      }, diagnostics);
      if (!exchange.response.ok) throw serviceError(exchange.response.status);

      const token = tokenSchema.safeParse(exchange.body);
      if (!token.success || token.data.token_type.toLowerCase() !== 'bearer') {
        throw invalidServiceResponse();
      }

      diagnostics = {
        stage: 'userinfo',
        startedAt: this.now(),
        failureKind: 'invalid-response',
      };
      const user = await this.userInfo(token.data.access_token, flow.controller.signal, diagnostics);
      if (!user) throw invalidServiceResponse();
      const issuedAt = this.now();
      diagnostics = {
        stage: 'credential-save',
        startedAt: issuedAt,
        failureKind: 'credential-save-failed',
      };
      const record = await this.dependencies.credentials.save({
        accessToken: token.data.access_token,
        accessTokenExpiresAt: issuedAt + token.data.expires_in * 1_000,
        refreshToken: token.data.refresh_token,
        refreshTokenExpiresAt: issuedAt + REFRESH_TOKEN_LIFETIME_MS,
        user,
      });
      return signedIn(user, record.storage, 'verified');
    } catch (error) {
      if (!denied && !flow.controller.signal.aborted && !signal.aborted) {
        this.logSignInFailure(flow, diagnostics, error);
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      this.flows.delete(flow.id);
      flow.listener.close();
      flow.controller.abort();
    }
  }

  async reopenSignIn(flowId: string): Promise<void> {
    const flow = this.requireFlow(flowId);
    const startedAt = this.now();
    try {
      await this.dependencies.openExternal(flow.authorizationUrl);
    } catch (error) {
      if (!flow.controller.signal.aborted) {
        this.logSignInFailure(flow, {
          stage: 'browser-open',
          startedAt,
          failureKind: 'browser-open-failed',
        }, error);
      }
      throw error;
    }
  }

  cancelSignIn(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    this.flows.delete(flowId);
    flow.listener.close();
    flow.controller.abort(abortError());
  }

  async signOut(signal?: AbortSignal): Promise<PiskieAccountStatus> {
    this.cancelAllFlows();
    const record = await this.dependencies.credentials.load();
    if (record) {
      try {
        await this.request('/api/auth/oauth2/revoke', {
          method: 'POST',
          form: {
            client_id: CLIENT_ID,
            token: record.credential.refreshToken,
            token_type_hint: 'refresh_token',
          },
          signal,
        });
      } catch {
        // Local sign-out must still remove the credential if the service is offline.
      }
    }
    await this.dependencies.credentials.clear();
    return { state: 'signed-out' };
  }

  dispose(): void {
    this.cancelAllFlows();
  }

  private async userInfo(
    accessToken: string,
    signal?: AbortSignal,
    diagnostics?: RequestDiagnostics,
  ): Promise<PiskieAccountUser | null> {
    const exchange = await this.request('/api/auth/oauth2/userinfo', {
      method: 'GET',
      accessToken,
      signal,
    }, diagnostics);
    if (!exchange.response.ok) {
      if ([401, 403].includes(exchange.response.status)) return null;
      throw serviceError(exchange.response.status);
    }
    const parsed = userInfoSchema.safeParse(exchange.body);
    if (!parsed.success) throw invalidServiceResponse();
    return Object.freeze({
      id: parsed.data.sub,
      email: parsed.data.email,
      name: parsed.data.name ?? parsed.data.email.split('@')[0] ?? parsed.data.email,
      ...(parsed.data.picture && { image: parsed.data.picture }),
    });
  }

  private async refreshCredential(
    record: AccountCredentialRecord,
    signal?: AbortSignal,
  ): Promise<AccountCredentialRecord | null> {
    this.refreshInFlight ??= this.performRefresh(record).finally(() => {
      this.refreshInFlight = undefined;
    });
    return waitWithAbort(this.refreshInFlight, signal);
  }

  private async performRefresh(
    record: AccountCredentialRecord,
  ): Promise<AccountCredentialRecord | null> {
    const latest = await this.dependencies.credentials.load();
    if (
      latest
      && latest.credential.refreshToken !== record.credential.refreshToken
      && latest.credential.accessTokenExpiresAt > this.now() + ACCESS_TOKEN_REFRESH_SKEW_MS
    ) {
      return latest;
    }

    const exchange = await this.request('/api/auth/oauth2/token', {
      method: 'POST',
      form: {
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: record.credential.refreshToken,
      },
    });

    if (!exchange.response.ok) {
      const protocolError = protocolErrorSchema.safeParse(exchange.body);
      if (
        exchange.response.status < 500
        && exchange.response.status !== 429
        && protocolError.success
      ) {
        await this.dependencies.credentials.clear();
        return null;
      }
      throw serviceError(exchange.response.status);
    }

    const token = tokenSchema.safeParse(exchange.body);
    if (!token.success || token.data.token_type.toLowerCase() !== 'bearer') {
      throw invalidServiceResponse();
    }

    const issuedAt = this.now();
    const credential: AccountCredential = {
      accessToken: token.data.access_token,
      accessTokenExpiresAt: issuedAt + token.data.expires_in * 1_000,
      refreshToken: token.data.refresh_token,
      refreshTokenExpiresAt: issuedAt + REFRESH_TOKEN_LIFETIME_MS,
      user: record.credential.user,
    };
    return this.dependencies.credentials.save(credential);
  }

  private async request(
    pathname: string,
    options: {
      method: 'GET' | 'POST';
      form?: Readonly<Record<string, string>>;
      accessToken?: string;
      signal?: AbortSignal;
    },
    diagnostics?: RequestDiagnostics,
  ): Promise<{ response: Response; body: unknown }> {
    if (diagnostics) diagnostics.requestPath = pathname;
    if (options.signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await (this.dependencies.fetch ?? globalThis.fetch)(
        new URL(pathname, this.baseUrl),
        {
          method: options.method,
          headers: {
            Accept: 'application/json',
            ...(options.form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
            ...(options.accessToken && { Authorization: `Bearer ${options.accessToken}` }),
          },
          ...(options.form && { body: new URLSearchParams(options.form).toString() }),
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (diagnostics) {
        diagnostics.httpStatus = response.status;
        if (!response.ok) diagnostics.failureKind = 'http-error';
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw invalidServiceResponse();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw invalidServiceResponse();
        }
      }
      return { response, body };
    } catch (error) {
      if (error instanceof PublicOperationError) {
        if (diagnostics) diagnostics.failureKind = 'invalid-response';
        throw error;
      }
      if (options.signal?.aborted) throw abortError();
      if (diagnostics) {
        diagnostics.failureKind = timedOut ? 'request-timeout' : 'network-error';
        diagnostics.systemErrorCode = signInSystemErrorCode(error) ?? (timedOut ? undefined : 'unknown');
      }
      if (timedOut) {
        throw new PublicOperationError('deadline-exceeded', 'The Piskie account service timed out', {
          retryable: true,
        });
      }
      throw new PublicOperationError('unavailable', 'The Piskie account service is unavailable', {
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  private logSignInFailure(
    attempt: Pick<SignInFlow, 'id' | 'startedAt'>,
    diagnostics: SignInDiagnostics,
    error?: unknown,
  ): void {
    const now = this.now();
    const systemErrorCode = diagnostics.systemErrorCode ?? signInSystemErrorCode(error);
    appLog.error({
      event: 'account.sign_in.failed',
      message: 'Account sign-in failed',
      context: {
        scope: 'account.sign_in',
        flowId: attempt.id,
        stage: diagnostics.stage,
        durationMs: now - diagnostics.startedAt,
        signInDurationMs: now - attempt.startedAt,
        failureKind: diagnostics.failureKind,
        ...(diagnostics.requestPath && { requestPath: diagnostics.requestPath }),
        ...(diagnostics.httpStatus !== undefined && { httpStatus: diagnostics.httpStatus }),
        ...(systemErrorCode && { systemErrorCode }),
      },
    });
  }

  private requireFlow(flowId: string): SignInFlow {
    const flow = this.flows.get(flowId);
    if (!flow || flow.expiresAt <= this.now()) {
      if (flow) this.cancelSignIn(flowId);
      throw new PublicOperationError('not-found', 'The account sign-in request has expired');
    }
    return flow;
  }

  private cancelAllFlows(): void {
    for (const flowId of [...this.flows.keys()]) this.cancelSignIn(flowId);
  }

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  private randomSecret(): string {
    return this.dependencies.randomSecret?.() ?? randomBytes(48).toString('base64url');
  }
}

// Only known platform/transport codes are selected; exception text and other fields stay out of logs.
const SIGN_IN_SYSTEM_ERROR_CODES = new Set([
  'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'ENOENT', 'ENOTDIR', 'EISDIR',
  'EMFILE', 'ENFILE', 'EIO', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function signInSystemErrorCode(error: unknown): string | undefined {
  const candidates = [error];
  if (error instanceof Error) candidates.push(error.cause);
  // Node fetch can wrap per-address connection failures in an AggregateError cause.
  for (const candidate of [...candidates]) {
    if (candidate instanceof AggregateError) candidates.push(...candidate.errors);
  }
  for (const candidate of candidates) {
    if (
      candidate instanceof Error
      && 'code' in candidate
      && typeof candidate.code === 'string'
      && SIGN_IN_SYSTEM_ERROR_CODES.has(candidate.code)
    ) return candidate.code;
  }
  return undefined;
}

function signedIn(
  user: PiskieAccountUser,
  credentialStorage: 'secure' | 'session',
  connection: 'verified' | 'offline',
): PiskieAccountStatus {
  return Object.freeze({ state: 'signed-in', user, credentialStorage, connection });
}

function sameUser(left: PiskieAccountUser, right: PiskieAccountUser): boolean {
  return left.id === right.id
    && left.email === right.email
    && left.name === right.name
    && left.image === right.image;
}

function serviceError(status: number): PublicOperationError {
  return new PublicOperationError(
    'unavailable',
    'The Piskie account service could not complete the request',
    { retryable: status === 429 || status >= 500 },
  );
}

function invalidServiceResponse(): PublicOperationError {
  return new PublicOperationError('unavailable', 'The Piskie account service returned an invalid response');
}

function signInExpired(): PublicOperationError {
  return new PublicOperationError(
    'deadline-exceeded',
    'The account sign-in request has expired',
    { details: { reason: ACCOUNT_FAULT_REASONS.signInExpired } },
  );
}

function isAllowedLoopbackRedirect(value: string): boolean {
  try {
    const target = new URL(value);
    const port = Number(target.port);
    return target.protocol === 'http:'
      && target.hostname === '127.0.0.1'
      && target.pathname === '/oauth/callback'
      && target.username === ''
      && target.password === ''
      && target.search === ''
      && target.hash === ''
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535;
  } catch {
    return false;
  }
}

function abortError(): Error {
  const error = new Error('The operation was cancelled');
  error.name = 'AbortError';
  return error;
}

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
