import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { ACCOUNT_FAULT_REASONS } from '../../../shared/electron-contracts/account.js';
import type { OAuthCallbackResult, OAuthLoopbackListener } from '../oauth-loopback.js';
import type { AccountCredential, AccountCredentialRecord } from '../credential-store.js';
import { AccountApplication } from '../account-application.js';

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
} = {}) {
  const responses = [...(options.responses ?? [])];
  let record: AccountCredentialRecord | null = options.initialCredential
    ? { credential: options.initialCredential, storage: 'secure' }
    : null;
  const fetch = vi.fn(async () => {
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
  const application = new AccountApplication({
    baseUrl: BASE_URL,
    credentials,
    fetch,
    listenForOAuthCallback,
    now: () => NOW,
    openExternal,
    randomSecret: () => secrets.shift() ?? STATE,
  });
  return { application, credentials, fetch, listenForOAuthCallback, listener, openExternal };
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
  });

  it('maps a browser denial without attempting a token exchange', async () => {
    const { application, fetch } = fixture({ callback: { error: 'access_denied' } });
    const challenge = await application.beginSignIn();

    await expect(application.waitForSignIn(
      challenge.flowId,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'forbidden' });
    expect(fetch).not.toHaveBeenCalled();
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
  });

  it('rejects callback listeners that do not bind to the fixed loopback route', async () => {
    const { application, listener, openExternal } = fixture({
      redirectUri: 'https://attacker.example/oauth/callback',
    });

    await expect(application.beginSignIn()).rejects.toMatchObject({ code: 'unavailable' });
    expect(listener.close).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();
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
