import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNT_FAULT_REASONS } from '../../../shared/electron-contracts/account.js';
import type { OAuthCallbackResult, OAuthLoopbackListener } from '../oauth-loopback.js';
import type { AccountCredential, AccountCredentialRecord } from '../credential-store.js';
import { AccountApplication } from '../account-application.js';
import { appLog, createAppLog, MemoryLogSink } from '../../observability/logging/app-log.js';

vi.mock('../../observability/logging/app-log.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../observability/logging/app-log.js')>(),
  appLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const BASE_URL = 'https://account.example.test';
const REDIRECT_URI = 'http://127.0.0.1:43123/oauth/callback';
const ACCESS_TOKEN = 'access-token-private-value';
const REFRESH_TOKEN = 'refresh-token-private-value';
const NEXT_ACCESS_TOKEN = 'next-access-token-private-value';
const NEXT_REFRESH_TOKEN = 'next-refresh-token-private-value';
const AUTHORIZATION_CODE = 'authorization-code-private-value';
const STATE = 'state-secret-value-that-is-long-enough-for-oauth';
const VERIFIER = 'verifier-secret-value-that-is-long-enough-for-pkce-1234567890';
const NONCE = 'nonce-secret-value-that-is-long-enough-for-oidc';
const NOW = 2_000_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenResponse(
  accessToken = ACCESS_TOKEN,
  refreshToken = REFRESH_TOKEN,
): Response {
  return jsonResponse({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: 3_600,
    scope: 'openid profile email offline_access',
  });
}

function userInfoResponse(): Response {
  return jsonResponse({
    sub: 'user-1',
    email: 'person@example.com',
    name: 'Person',
    picture: null,
  });
}

function credential(overrides: Partial<AccountCredential> = {}): AccountCredential {
  return {
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt: NOW + 3_600_000,
    refreshToken: REFRESH_TOKEN,
    refreshTokenExpiresAt: NOW + 30 * 24 * 60 * 60_000,
    user: { id: 'user-1', email: 'person@example.com', name: 'Person' },
    ...overrides,
  };
}

function fixture(options: {
  callback?: OAuthCallbackResult;
  initialCredential?: AccountCredential;
  redirectUri?: string;
  responses?: Response[];
  now?: () => number;
  useGlobalFetch?: boolean;
} = {}) {
  const responses = [...(options.responses ?? [])];
  let record: AccountCredentialRecord | null = options.initialCredential
    ? { credential: options.initialCredential, storage: 'secure' }
    : null;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch');
    return response;
  });
  const credentials = {
    load: vi.fn(async () => record),
    save: vi.fn(async (nextCredential: AccountCredential) => {
      record = { credential: nextCredential, storage: 'secure' };
      return record;
    }),
    clear: vi.fn(async () => {
      record = null;
    }),
  };
  const listener: OAuthLoopbackListener = {
    redirectUri: options.redirectUri ?? REDIRECT_URI,
    wait: vi.fn(async () => options.callback ?? { code: AUTHORIZATION_CODE }),
    close: vi.fn(),
  };
  const listenForOAuthCallback = vi.fn(async () => listener);
  const openExternal = vi.fn(async () => undefined);
  const secrets = [STATE, VERIFIER, NONCE];
  if (options.useGlobalFetch) vi.stubGlobal('fetch', fetch);
  const application = new AccountApplication({
    baseUrl: BASE_URL,
    credentials,
    ...(!options.useGlobalFetch && { fetch }),
    listenForOAuthCallback,
    now: options.now ?? (() => NOW),
    openExternal,
    randomSecret: () => secrets.shift() ?? STATE,
  });
  return { application, credentials, fetch, listenForOAuthCallback, listener, openExternal };
}

function expectNoSignInLogs(): void {
  expect(appLog.debug).not.toHaveBeenCalled();
  expect(appLog.info).not.toHaveBeenCalled();
  expect(appLog.warn).not.toHaveBeenCalled();
  expect(appLog.error).not.toHaveBeenCalled();
}

function expectSignInFailure(context: Record<string, unknown>) {
  expect(appLog.debug).not.toHaveBeenCalled();
  expect(appLog.info).not.toHaveBeenCalled();
  expect(appLog.warn).not.toHaveBeenCalled();
  expect(appLog.error).toHaveBeenCalledExactlyOnceWith({
    event: 'account.sign_in.failed',
    message: 'Account sign-in failed',
    context: {
      scope: 'account.sign_in',
      flowId: expect.any(String),
      durationMs: 0,
      signInDurationMs: 0,
      ...(context.stage === 'token-exchange' && { requestPath: '/api/auth/oauth2/token' }),
      ...(context.stage === 'userinfo' && { requestPath: '/api/auth/oauth2/userinfo' }),
      ...context,
    },
  });
  return vi.mocked(appLog.error).mock.calls[0]![0];
}

describe('AccountApplication OAuth authorization code flow', () => {
  it('uses loopback PKCE and keeps every credential in the main process', async () => {
    const { application, credentials, fetch, listenForOAuthCallback, listener, openExternal } = fixture({
      responses: [tokenResponse(), userInfoResponse()],
    });

    const challenge = await application.beginSignIn();
    expect(JSON.stringify(challenge)).not.toContain(VERIFIER);
    expect(JSON.stringify(challenge)).not.toContain(AUTHORIZATION_CODE);
    expect(JSON.stringify(challenge)).not.toContain(ACCESS_TOKEN);
    expect(challenge).toEqual({
      flowId: expect.any(String),
      expiresAt: NOW + 10 * 60_000,
    });
    expect(listenForOAuthCallback).toHaveBeenCalledWith({
      expectedIssuer: `${BASE_URL}/api/auth`,
      expectedState: STATE,
      timeoutMs: 10 * 60_000,
    });

    const authorizationUrl = new URL(openExternal.mock.calls[0]?.[0] as string);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      `${BASE_URL}/api/auth/oauth2/authorize`,
    );
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      client_id: 'piskie-desktop',
      code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
      code_challenge_method: 'S256',
      nonce: NONCE,
      prompt: 'consent',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid profile email offline_access',
      state: STATE,
    });

    const status = await application.waitForSignIn(
      challenge.flowId,
      new AbortController().signal,
    );

    expect(status).toEqual({
      state: 'signed-in',
      user: { id: 'user-1', email: 'person@example.com', name: 'Person' },
      connection: 'verified',
      credentialStorage: 'secure',
    });
    expect(JSON.stringify(status)).not.toContain(ACCESS_TOKEN);
    expect(credentials.save).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      accessTokenExpiresAt: NOW + 3_600_000,
      refreshTokenExpiresAt: NOW + 30 * 24 * 60 * 60_000,
    }));
    const tokenRequest = fetch.mock.calls[0];
    expect(String(tokenRequest?.[0])).toBe(`${BASE_URL}/api/auth/oauth2/token`);
    expect(new URLSearchParams(tokenRequest?.[1]?.body as string)).toEqual(
      new URLSearchParams({
        client_id: 'piskie-desktop',
        code: AUTHORIZATION_CODE,
        code_verifier: VERIFIER,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    );
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    expect(listener.close).toHaveBeenCalledOnce();
    expectNoSignInLogs();
  });

  it('maps a browser denial without attempting a token exchange', async () => {
    const { application, fetch } = fixture({ callback: { error: 'access_denied' } });
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(
      challenge.flowId,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'forbidden' });
    expect(fetch).not.toHaveBeenCalled();
    expectNoSignInLogs();
  });

  it('marks callback expiry separately from account-service timeouts', async () => {
    const { application, fetch } = fixture({ callback: { error: 'expired' } });
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(
      challenge.flowId,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'deadline-exceeded',
      options: { details: { reason: ACCOUNT_FAULT_REASONS.signInExpired } },
    });
    expect(fetch).not.toHaveBeenCalled();
    expectSignInFailure({
      flowId: challenge.flowId,
      stage: 'callback-wait',
      failureKind: 'authorization-expired',
    });
  });

  it('rejects callback listeners that do not bind to the fixed loopback route', async () => {
    const { application, listener, openExternal } = fixture({
      redirectUri: 'https://attacker.example/oauth/callback',
    });

    await expect(application.beginSignIn()).rejects.toMatchObject({ code: 'unavailable' });
    expect(listener.close).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();
    expectSignInFailure({ stage: 'callback-listen', failureKind: 'invalid-redirect' });
  });

  it('refreshes lazily once for concurrent callers and rotates the refresh token', async () => {
    const { application, credentials, fetch } = fixture({
      initialCredential: credential({ accessTokenExpiresAt: NOW - 1 }),
      responses: [
        tokenResponse(NEXT_ACCESS_TOKEN, NEXT_REFRESH_TOKEN),
        userInfoResponse(),
        userInfoResponse(),
      ],
    });

    const [first, second] = await Promise.all([application.status(), application.status()]);

    expect(first.state).toBe('signed-in');
    expect(second.state).toBe('signed-in');
    const tokenRequests = fetch.mock.calls.filter(([input]) =>
      String(input).endsWith('/api/auth/oauth2/token'));
    expect(tokenRequests).toHaveLength(1);
    expect(new URLSearchParams(tokenRequests[0]?.[1]?.body as string).get('refresh_token'))
      .toBe(REFRESH_TOKEN);
    expect(credentials.save).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: NEXT_ACCESS_TOKEN,
      refreshToken: NEXT_REFRESH_TOKEN,
    }));
  });

  it('does not refresh while the access token is still valid', async () => {
    const { application, fetch } = fixture({
      initialCredential: credential(),
      responses: [userInfoResponse()],
    });

    await expect(application.status()).resolves.toMatchObject({ state: 'signed-in' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0]).endsWith('/api/auth/oauth2/userinfo')).toBe(true);
  });

  it('clears a rejected refresh token instead of retrying it', async () => {
    const { application, credentials } = fixture({
      initialCredential: credential({ accessTokenExpiresAt: NOW - 1 }),
      responses: [jsonResponse({ error: 'invalid_grant' }, 400)],
    });

    await expect(application.status()).resolves.toEqual({ state: 'signed-out' });
    expect(credentials.clear).toHaveBeenCalledOnce();
  });

  it('revokes the refresh token but still clears local state when revocation fails', async () => {
    const { application, credentials, fetch } = fixture({
      initialCredential: credential(),
    });

    await expect(application.signOut()).resolves.toEqual({ state: 'signed-out' });
    expect(new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as string)).toEqual(
      new URLSearchParams({
        client_id: 'piskie-desktop',
        token: REFRESH_TOKEN,
        token_type_hint: 'refresh_token',
      }),
    );
    expect(credentials.clear).toHaveBeenCalledOnce();
  });
});

describe('AccountApplication sign-in failure logs', () => {
  it('records local listener failures without forwarding the original exception', async () => {
    const { application, listenForOAuthCallback, openExternal } = fixture();
    listenForOAuthCallback.mockRejectedValueOnce(Object.assign(
      new Error(`Listener failed for ${REDIRECT_URI}?code=${AUTHORIZATION_CODE}&state=${STATE}`),
      { code: 'EACCES', authorization: `Bearer ${ACCESS_TOKEN}` },
    ));

    await expect(application.beginSignIn()).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Piskie could not open a local OAuth callback port',
    });
    expect(openExternal).not.toHaveBeenCalled();
    expectSignInFailure({
      stage: 'callback-listen',
      failureKind: 'listener-unavailable',
      systemErrorCode: 'EACCES',
    });
  });

  it.each(['begin', 'reopen'] as const)('records browser launch errors during %s', async (operation) => {
    const { application, openExternal } = fixture();
    const challenge = operation === 'reopen' ? await application.beginSignIn() : undefined;
    const error = new Error(`Unable to open ${BASE_URL}?state=${STATE}&code_verifier=${VERIFIER}`);
    openExternal.mockRejectedValueOnce(error);

    await expect(challenge
      ? application.reopenSignIn(challenge.flowId)
      : application.beginSignIn()).rejects.toBe(error);
    expectSignInFailure({
      ...(challenge && { flowId: challenge.flowId }),
      stage: 'browser-open',
      failureKind: 'browser-open-failed',
    });
    application.dispose();
  });

  it.each([
    { error: 'callback_failed', failureKind: 'callback-failed' },
    { error: AUTHORIZATION_CODE, failureKind: 'authorization-failed' },
  ])('classifies callback errors as $failureKind without logging callback data', async ({ error, failureKind }) => {
    const errorDescription = `Authorization failed for person@example.com ${ACCESS_TOKEN} ${VERIFIER}`;
    const { application, fetch } = fixture({ callback: { error, errorDescription } });
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(challenge.flowId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable', message: errorDescription });
    expect(fetch).not.toHaveBeenCalled();
    expectSignInFailure({ flowId: challenge.flowId, stage: 'callback-wait', failureKind });
  });

  it.each([
    { stage: 'token-exchange', httpStatus: 400 },
    { stage: 'token-exchange', httpStatus: 503 },
    { stage: 'userinfo', httpStatus: 401 },
    { stage: 'userinfo', httpStatus: 503 },
  ])('records $stage HTTP $httpStatus once without response content', async ({ stage, httpStatus }) => {
    const rejection = jsonResponse({
      error: ACCESS_TOKEN,
      error_description: `Rejected ${AUTHORIZATION_CODE} ${STATE} ${VERIFIER} person@example.com`,
      refresh_token: REFRESH_TOKEN,
    }, httpStatus);
    const { application, credentials } = fixture({
      responses: stage === 'userinfo' ? [tokenResponse(), rejection] : [rejection],
    });
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(challenge.flowId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect(credentials.save).not.toHaveBeenCalled();
    expectSignInFailure({ flowId: challenge.flowId, stage, failureKind: 'http-error', httpStatus });
  });

  it.each(['token-exchange', 'userinfo'] as const)(
    'preserves safe network codes from global fetch failures during %s',
    async (stage) => {
      let now = NOW;
      const { application, fetch } = fixture({ useGlobalFetch: true, now: () => now });
      if (stage === 'userinfo') fetch.mockResolvedValueOnce(tokenResponse());
      fetch.mockImplementationOnce(async () => {
        now += 250;
        throw new TypeError(`Fetch failed with ${ACCESS_TOKEN} ${REFRESH_TOKEN}`, {
          cause: new AggregateError([
            Object.assign(new Error(`Connection failed for ${BASE_URL}?code=${AUTHORIZATION_CODE}`), {
              code: 'ENETUNREACH',
              address: '192.0.2.1',
              request: { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, body: VERIFIER },
            }),
            Object.assign(new Error(STATE), { code: 'ECONNREFUSED' }),
          ], 'Connection attempts failed'),
        });
      });
      const challenge = await application.beginSignIn();
      now += 50;

      await expect(application.waitForSignIn(challenge.flowId, new AbortController().signal))
        .rejects.toMatchObject({
          code: 'unavailable',
          message: 'The Piskie account service is unavailable',
          options: { retryable: true },
        });
      const record = expectSignInFailure({
        flowId: challenge.flowId,
        stage,
        failureKind: 'network-error',
        systemErrorCode: 'ENETUNREACH',
        durationMs: 250,
        signInDurationMs: 300,
      });
      const sink = new MemoryLogSink();
      createAppLog({ sink }).error(record);
      expect(JSON.parse(JSON.stringify(sink.events))).toEqual([{
        id: expect.any(String),
        timestamp: expect.any(String),
        origin: 'main',
        level: 'error',
        event: 'account.sign_in.failed',
        message: 'Account sign-in failed',
        scope: 'account.sign_in',
        context: {
          flowId: challenge.flowId,
          stage,
          requestPath: stage === 'token-exchange' ? '/api/auth/oauth2/token' : '/api/auth/oauth2/userinfo',
          failureKind: 'network-error',
          systemErrorCode: 'ENETUNREACH',
          durationMs: 250,
          signInDurationMs: 300,
        },
      }]);
    },
  );

  it.each([
    { code: 'ENOTFOUND', expectedCode: 'ENOTFOUND' },
    { code: 'UND_ERR_CONNECT_TIMEOUT', expectedCode: 'UND_ERR_CONNECT_TIMEOUT' },
    { code: 'ECONNRESET', expectedCode: 'ECONNRESET' },
    { code: 'ERR_TLS_CERT_ALTNAME_INVALID', expectedCode: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    { code: undefined, expectedCode: 'unknown' },
    { code: ACCESS_TOKEN, expectedCode: 'unknown' },
  ])('records the available network cause code as $expectedCode', async ({ code, expectedCode }) => {
    const { application, fetch } = fixture();
    fetch.mockRejectedValueOnce(new TypeError(`Fetch failed ${ACCESS_TOKEN}`, {
      cause: Object.assign(new Error(`Connection failed ${REFRESH_TOKEN}`), { code }),
    }));
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(challenge.flowId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable', options: { retryable: true } });
    expectSignInFailure({
      flowId: challenge.flowId,
      stage: 'token-exchange',
      failureKind: 'network-error',
      systemErrorCode: expectedCode,
    });
  });

  it.each(['token-exchange', 'userinfo'] as const)('records the request timeout during %s', async (stage) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { application, credentials, fetch, listener } = fixture({ now: Date.now });
    if (stage === 'userinfo') fetch.mockResolvedValueOnce(tokenResponse());
    fetch.mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(ACCESS_TOKEN)), { once: true });
    }));
    const challenge = await application.beginSignIn();
    const result = expect(application.waitForSignIn(challenge.flowId, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'deadline-exceeded',
        message: 'The Piskie account service timed out',
        options: { retryable: true },
      });

    await vi.advanceTimersByTimeAsync(45_000);
    await result;
    expectSignInFailure({
      flowId: challenge.flowId,
      stage,
      failureKind: 'request-timeout',
      durationMs: 45_000,
      signInDurationMs: 45_000,
    });
    expect(credentials.save).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalledOnce();
  });

  it('retains HTTP status when reading a response fails', async () => {
    const response = jsonResponse({});
    vi.spyOn(response, 'text').mockRejectedValueOnce(Object.assign(
      new Error(`Response interrupted ${ACCESS_TOKEN}`),
      { code: 'UND_ERR_SOCKET', response: { body: REFRESH_TOKEN } },
    ));
    const { application } = fixture({ responses: [tokenResponse(), response] });
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(challenge.flowId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable', options: { retryable: true } });
    expectSignInFailure({
      flowId: challenge.flowId,
      stage: 'userinfo',
      failureKind: 'network-error',
      httpStatus: 200,
      systemErrorCode: 'UND_ERR_SOCKET',
    });
  });

  it.each([
    { stage: 'token-exchange', kind: 'schema', httpStatus: 200 },
    { stage: 'userinfo', kind: 'schema', httpStatus: 200 },
    { stage: 'token-exchange', kind: 'json', httpStatus: 502 },
    { stage: 'userinfo', kind: 'size', httpStatus: 200 },
  ])('records invalid $kind responses during $stage', async ({ stage, kind, httpStatus }) => {
    const response = kind === 'schema'
      ? jsonResponse({ access_token: ACCESS_TOKEN, email: 'person@example.com' })
      : new Response(kind === 'json' ? `invalid ${REFRESH_TOKEN}` : ACCESS_TOKEN.repeat(4_096), {
        status: httpStatus,
      });
    const { application } = fixture({
      responses: stage === 'userinfo' ? [tokenResponse(), response] : [response],
    });
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(challenge.flowId, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'unavailable',
        message: 'The Piskie account service returned an invalid response',
      });
    expectSignInFailure({ flowId: challenge.flowId, stage, failureKind: 'invalid-response', httpStatus });
  });

  it.each(['EACCES', ACCESS_TOKEN, undefined])('records credential save failures using only recognized codes (%s)', async (code) => {
    const { application, credentials } = fixture({ responses: [tokenResponse(), userInfoResponse()] });
    const error = Object.assign(new Error(`Save failed ${ACCESS_TOKEN} ${REFRESH_TOKEN} person@example.com`), {
      code,
      path: '/tmp/example-profile/account/secret.bin',
      credential: credential(),
    });
    credentials.save.mockRejectedValueOnce(error);
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(challenge.flowId, new AbortController().signal))
      .rejects.toBe(error);
    expectSignInFailure({
      flowId: challenge.flowId,
      stage: 'credential-save',
      failureKind: 'credential-save-failed',
      ...(code === 'EACCES' && { systemErrorCode: 'EACCES' }),
    });
  });

  it('does not log when the caller cancels before sign-in starts', async () => {
    const { application, listenForOAuthCallback } = fixture();
    const controller = new AbortController();
    controller.abort();

    await expect(application.beginSignIn(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(listenForOAuthCallback).not.toHaveBeenCalled();
    expectNoSignInLogs();
  });

  it('does not log when the user cancels while waiting for authorization', async () => {
    const { application, listener, fetch } = fixture();
    vi.mocked(listener.wait).mockImplementationOnce((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const challenge = await application.beginSignIn();
    const result = application.waitForSignIn(challenge.flowId, new AbortController().signal);

    application.cancelSignIn(challenge.flowId);

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    expectNoSignInLogs();
  });

  it.each(['token-exchange', 'userinfo'] as const)('does not log caller cancellation during %s', async (stage) => {
    const { application, fetch } = fixture();
    const controller = new AbortController();
    if (stage === 'userinfo') fetch.mockResolvedValueOnce(tokenResponse());
    fetch.mockImplementationOnce(async () => {
      controller.abort(new Error('User cancelled the operation'));
      throw new Error('Request interrupted');
    });
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(challenge.flowId, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expectNoSignInLogs();
  });
});
