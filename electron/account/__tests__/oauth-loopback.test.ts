import { describe, expect, it } from 'vitest';

import { startOAuthLoopbackListener } from '../oauth-loopback.js';

const STATE = 'state-bound-to-this-login';
const ISSUER = 'https://www.piskie.dev/api/auth';

describe('OAuth loopback listener', () => {
  it('ignores mismatched callbacks and accepts one state-and-issuer-bound code', async () => {
    const listener = await startOAuthLoopbackListener({
      expectedIssuer: ISSUER,
      expectedState: STATE,
      timeoutMs: 5_000,
    });
    const invalid = new URL(listener.redirectUri);
    invalid.search = new URLSearchParams({
      code: 'attacker-code',
      iss: ISSUER,
      state: 'wrong-state',
    }).toString();

    await expect(fetch(invalid, {
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    })).resolves.toMatchObject({ status: 400 });

    const valid = new URL(listener.redirectUri);
    valid.search = new URLSearchParams({
      code: 'one-time-authorization-code',
      iss: ISSUER,
      state: STATE,
    }).toString();
    const callback = listener.wait(new AbortController().signal);
    const response = await fetch(valid, {
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('PISKIE / 桌面登录');
    expect(html).toContain('登录已完成');
    expect(html).not.toContain('class="mark"');
    expect(html).not.toContain('>OK<');
    await expect(callback).resolves.toEqual({ code: 'one-time-authorization-code' });
  });

  it('renders English for an English browser and honors language quality', async () => {
    const listener = await startOAuthLoopbackListener({
      expectedIssuer: ISSUER,
      expectedState: STATE,
      timeoutMs: 5_000,
    });
    const valid = new URL(listener.redirectUri);
    valid.search = new URLSearchParams({
      code: 'one-time-authorization-code',
      iss: ISSUER,
      state: STATE,
    }).toString();

    const callback = listener.wait(new AbortController().signal);
    const response = await fetch(valid, {
      headers: { 'Accept-Language': 'zh-CN;q=0.4, en-GB;q=0.9' },
    });
    const html = await response.text();
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain('PISKIE / DESKTOP AUTH');
    expect(html).toContain('Sign-in complete');
    expect(html).not.toContain('登录已完成');
    await expect(callback).resolves.toEqual({ code: 'one-time-authorization-code' });
  });

  it('requires the authorization-server issuer and rejects duplicate parameters', async () => {
    const listener = await startOAuthLoopbackListener({
      expectedIssuer: ISSUER,
      expectedState: STATE,
      timeoutMs: 5_000,
    });
    const target = new URL(listener.redirectUri);
    target.searchParams.append('code', 'first-code');
    target.searchParams.append('code', 'second-code');
    target.searchParams.set('iss', 'https://attacker.example/api/auth');
    target.searchParams.set('state', STATE);

    await expect(fetch(target)).resolves.toMatchObject({ status: 400 });
    listener.close();
  });
});
