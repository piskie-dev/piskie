import type { SearchProviderConfig, SearchProviderPreset } from '../../shared/types/web-search.js';
import { performOAuthLogin } from '../mcp/client/oauth/flow.js';
import { findIssuerRecordByResource, getValidAccessToken, removeResource } from '../mcp/client/oauth/store.js';
import { linkAbort, raceAbort } from '../utils/abort.js';
import type { ResolvedSearchAuth } from './contracts.js';
import { normalizeSearchError, searchError } from './errors.js';
import type { RegisteredSearchProvider } from './providers/index.js';

export class SearchAuth {
  private readonly logins = new Map<string, { controller: AbortController; done: Promise<void> }>();

  private readonly disconnects = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly configRoot: string) {}

  async resolve(
    definition: RegisteredSearchProvider,
    config: SearchProviderConfig,
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ): Promise<ResolvedSearchAuth> {
    signal.throwIfAborted();
    const authentication = definition.authentication.find((item) => item.kind === config.authentication);
    if (!authentication) throw searchError('auth_required');
    if (authentication.kind === 'anonymous') return { kind: 'anonymous' };
    if (authentication.kind === 'api_key') {
      const key = config.apiKey?.trim();
      if (!key) throw searchError('auth_required');
      return { kind: 'api_key', key };
    }
    const accessToken = await raceAbort(getValidAccessToken(this.configRoot, authentication.resourceUrl, fetch), signal);
    if (!accessToken) throw searchError('auth_required');
    return { kind: 'oauth', accessToken };
  }

  async status(definition: RegisteredSearchProvider): Promise<SearchProviderPreset['oauth']> {
    const oauth = definition.authentication.find((item) => item.kind === 'oauth');
    const record = oauth ? await findIssuerRecordByResource(this.configRoot, oauth.resourceUrl) : undefined;
    return { connected: Boolean(record), ...(record?.tokens.expiresAt ? { expiresAt: record.tokens.expiresAt } : {}) };
  }

  async connect(
    definition: RegisteredSearchProvider,
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
    openAuthorizationUrl: (url: string) => Promise<void>,
  ): Promise<void> {
    signal.throwIfAborted();
    const authentication = definition.authentication.find((item) => item.kind === 'oauth');
    if (!authentication) throw searchError('auth_required');
    const disconnecting = this.disconnects.get(definition.id);
    if (disconnecting) {
      await raceAbort(disconnecting, signal);
      return this.connect(definition, fetch, signal, openAuthorizationUrl);
    }
    if (this.closed) throw new DOMException('Search authentication closed', 'AbortError');
    const previous = this.logins.get(definition.id);
    if (previous) return raceAbort(previous.done, signal);
    const controller = new AbortController();
    const unlink = linkAbort(signal, (reason) => controller.abort(reason));
    const login = { controller, done: Promise.resolve() };
    login.done = (async () => {
      try {
        await performOAuthLogin({
          serverName: definition.label,
          configRoot: this.configRoot,
          config: { url: authentication.resourceUrl },
          scopes: [...authentication.scopes],
          fetch, signal: controller.signal, openAuthorizationUrl,
        });
      } catch (error) {
        throw normalizeSearchError(error, controller.signal);
      } finally {
        unlink();
        if (this.logins.get(definition.id) === login) this.logins.delete(definition.id);
      }
    })();
    this.logins.set(definition.id, login);
    return login.done;
  }

  async cancel(providerId: string): Promise<void> {
    const login = this.logins.get(providerId);
    login?.controller.abort();
    await login?.done.catch(() => undefined);
  }

  async disconnect(definition: RegisteredSearchProvider): Promise<void> {
    const previous = this.disconnects.get(definition.id);
    if (previous) return previous;
    const done = (async () => {
      await this.cancel(definition.id);
      const oauth = definition.authentication.find((item) => item.kind === 'oauth');
      if (oauth) await removeResource(this.configRoot, oauth.resourceUrl);
    })();
    this.disconnects.set(definition.id, done);
    try { await done; } finally {
      if (this.disconnects.get(definition.id) === done) this.disconnects.delete(definition.id);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.logins.keys()].map((id) => this.cancel(id)));
    await Promise.allSettled([...this.disconnects.values()]);
  }
}
