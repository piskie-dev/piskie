import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchAuth } from '../auth.js';
import { searchProviders } from '../providers/index.js';
import { performOAuthLogin } from '../../mcp/client/oauth/flow.js';
import { getValidAccessToken, removeResource } from '../../mcp/client/oauth/store.js';
import { defaultWebSearchConfig } from '../../config/domains/web-search.adapter.js';

vi.mock('../../mcp/client/oauth/flow.js', () => ({ performOAuthLogin: vi.fn() }));
vi.mock('../../mcp/client/oauth/store.js', () => ({ getValidAccessToken: vi.fn(), findIssuerRecordByResource: vi.fn(), removeResource: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const definition = searchProviders.get('parallel')!;
const config = defaultWebSearchConfig().providers.parallel!;

describe('search authentication with the existing OAuth owner', () => {
  it('uses only explicitly selected authentication even when OAuth credentials already exist', async () => {
    const auth = new SearchAuth('/tmp/example-config');
    vi.mocked(getValidAccessToken).mockResolvedValue('fake-oauth-token');
    const signal = new AbortController().signal;
    expect(await auth.resolve(definition, { ...config, apiKey: 'fake-key' }, fetch, signal)).toEqual({ kind: 'anonymous' });
    expect(await auth.resolve(definition, { ...config, authentication: 'api_key', apiKey: 'fake-key' }, fetch, signal))
      .toEqual({ kind: 'api_key', key: 'fake-key' });
    expect(getValidAccessToken).not.toHaveBeenCalled();
    expect(await auth.resolve(definition, { ...config, authentication: 'oauth' }, fetch, signal))
      .toEqual({ kind: 'oauth', accessToken: 'fake-oauth-token' });
    expect(getValidAccessToken).toHaveBeenCalledWith('/tmp/example-config', 'https://search.parallel.ai/mcp-oauth', fetch);
  });

  it('cancels one caller waiting for shared token refresh while allowing another caller to finish', async () => {
    const refreshed = Promise.withResolvers<string>();
    vi.mocked(getValidAccessToken).mockReturnValue(refreshed.promise);
    const auth = new SearchAuth('/tmp/example-config');
    const cancelled = new AbortController();
    const reason = new Error('example interruption');
    const first = auth.resolve(definition, { ...config, authentication: 'oauth' }, fetch, cancelled.signal);
    const second = auth.resolve(definition, { ...config, authentication: 'oauth' }, fetch, new AbortController().signal);
    const failed = expect(first).rejects.toBe(reason);
    cancelled.abort(reason);
    await failed;
    refreshed.resolve('fake-refreshed-token');
    await expect(second).resolves.toEqual({ kind: 'oauth', accessToken: 'fake-refreshed-token' });
  });

  it('shares repeated login attempts and finishes cancellation before disconnecting the resource', async () => {
    const settled = vi.fn();
    vi.mocked(performOAuthLogin).mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { settled(); reject(signal!.reason); }, { once: true });
    }));
    vi.mocked(removeResource).mockImplementation(async () => { expect(settled).toHaveBeenCalledOnce(); return true; });
    const auth = new SearchAuth('/tmp/example-config');
    const open = vi.fn();
    const one = auth.connect(definition, fetch, new AbortController().signal, open);
    const two = auth.connect(definition, fetch, new AbortController().signal, open);
    const results = Promise.allSettled([one, two]);
    expect(performOAuthLogin).toHaveBeenCalledOnce();
    await auth.disconnect(definition);
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    expect(removeResource).toHaveBeenCalledWith('/tmp/example-config', 'https://search.parallel.ai/mcp-oauth');
  });
});
