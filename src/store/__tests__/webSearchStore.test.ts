import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebSearchDomain } from '../../../electron/config/domains/web-search.adapter';
import { buildConfigDescriptor } from '../../../electron/config/core/descriptor-builder';
import { resolveConfigFieldChanges } from '../../../electron/config/core/field-change-resolver';
import type { ConfigDomainRevisionChangedEvent, ConfigPlanRequest } from '../../../shared/types/config';
import { useWebSearchStore } from '../webSearchStore';

let root: string;
let domain: ReturnType<typeof createWebSearchDomain>;
let listener: ((event: ConfigDomainRevisionChangedEvent) => void) | undefined;
const connectOAuth = vi.fn();

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'search-settings-'));
  domain = createWebSearchDomain(root, { publish: () => undefined }, async () => ({ revision: 0, proxies: {} }));
  await domain.activate();
  const descriptor = buildConfigDescriptor(domain.contract);
  connectOAuth.mockReset();
  vi.stubGlobal('window', { piskie: {
    configuration: {
      read: () => domain.show(), describe: () => descriptor,
      plan: async (_id: string, request: ConfigPlanRequest) => domain.createPlan(resolveConfigFieldChanges(descriptor, request)),
      validate: (id: string) => domain.validate(id),
      apply: (id: string, revision: number) => domain.apply(id, revision),
      verify: (_id: string, revision: number) => domain.verify(revision),
      observeChanges: (callback: typeof listener) => { listener = callback; return () => { listener = undefined; }; },
    },
    webSearch: { connectOAuth, listProviders: async () => ['parallel', 'exa'].map((id) => ({
      id, label: id, authentication: [{ kind: 'anonymous' }], defaults: { authentication: 'anonymous', options: {} },
      optionsSchema: {}, connectionCheck: true, oauth: { connected: false },
    })) },
  } });
  useWebSearchStore.setState({ config: null, descriptor: null, presets: [], error: null, connecting: {} });
  await useWebSearchStore.getState().refresh();
});

afterEach(async () => {
  await useWebSearchStore.getState().waitForSaves();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('search settings using Configuration transactions', () => {
  it('serializes field saves, retains a key when switching authentication, and clears it explicitly', async () => {
    const store = useWebSearchStore.getState();
    expect(await Promise.all([
      store.updateProvider('parallel', { displayName: 'Example search' }),
      store.updateProvider('parallel', { apiKey: 'fake-key', authentication: 'api_key' }),
    ])).toEqual([true, true]);
    expect((await domain.show()).providers.parallel).toMatchObject({ displayName: 'Example search', apiKey: 'fake-key', authentication: 'api_key' });
    await store.updateProvider('parallel', { authentication: 'anonymous' });
    expect((await domain.show()).providers.parallel?.apiKey).toBe('fake-key');
    await store.updateProvider('parallel', { apiKey: undefined });
    expect((await domain.show()).providers.parallel?.apiKey).toBeUndefined();
  });

  it('clears the current selection in the same save when disabling or removing a provider', async () => {
    const store = useWebSearchStore.getState();
    expect(await store.updateProvider('parallel', { enabled: false })).toBe(true);
    expect(await domain.show()).toMatchObject({ revision: 1, defaultProvider: null });
    expect(await store.setDefaultProvider('exa')).toBe(true);
    expect(await store.removeProvider('exa')).toBe(true);
    expect(await domain.show()).toMatchObject({ revision: 3, defaultProvider: null });
    expect(await store.removeProvider('parallel')).toBe(true);
    expect(await store.addProvider('exa')).toBe(true);
    expect(await domain.show()).toMatchObject({ defaultProvider: 'exa' });
    expect(await store.addProvider('parallel')).toBe(true);
    expect((await domain.show()).defaultProvider).toBe('exa');
  });

  it('refreshes published configuration changes from another entry point', async () => {
    const unsubscribe = useWebSearchStore.getState().subscribeToConfigChanges();
    const plan = await domain.createPlan([{ op: 'replace', path: '/defaultProvider', value: 'exa' }]);
    await domain.apply(plan.id, 0);
    listener!({ domain: 'web-search', revision: 1, descriptorHash: useWebSearchStore.getState().descriptor!.descriptorHash } as ConfigDomainRevisionChangedEvent);
    await vi.waitFor(() => expect(useWebSearchStore.getState().config?.defaultProvider).toBe('exa'));
    unsubscribe();
  });

  it('presents serialized OAuth cancellation separately from authentication failures', async () => {
    connectOAuth.mockResolvedValue({ ok: false, cancelled: true });
    await useWebSearchStore.getState().connectOAuth('parallel');
    expect(useWebSearchStore.getState().authorizationResults.parallel).toBe('cancelled');
    expect(useWebSearchStore.getState().error).toBeNull();
    expect((await domain.show()).providers.parallel?.authentication).toBe('anonymous');
  });

  it('keeps concurrent settings when OAuth succeeds after the starting revision changed', async () => {
    const login = deferred<{ ok: true; value: undefined }>();
    connectOAuth.mockReturnValue(login.promise);
    const finished = useWebSearchStore.getState().connectOAuth('parallel');
    await vi.waitFor(() => expect(connectOAuth).toHaveBeenCalledOnce());
    await useWebSearchStore.getState().updateProvider('parallel', { displayName: 'Updated search' });
    login.resolve({ ok: true, value: undefined });
    await finished;
    expect((await domain.show()).providers.parallel).toMatchObject({ displayName: 'Updated search', authentication: 'anonymous' });
    expect(useWebSearchStore.getState().error).toMatchObject({ key: 'settings.webSearch.oauthSettingsChanged' });
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
