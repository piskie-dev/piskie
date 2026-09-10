import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebSearchDomain, defaultWebSearchConfig, parseWebSearchConfig, webSearchWriteSchema } from '../web-search.adapter.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'search-config-'));
  roots.push(root);
  const publish = vi.fn();
  const create = () => createWebSearchDomain(root, { publish }, async () => ({ revision: 0, proxies: {} }));
  const domain = create();
  await domain.activate();
  return { domain, create, publish };
}

describe('web-search configuration domain', () => {
  it('ignores unknown persisted fields and providers while applying registered defaults', () => {
    const config = parseWebSearchConfig({ revision: 2, enabled: true, defaultProvider: 'unknown', extra: true,
      providers: { unknown: { extra: 1 }, parallel: { extra: true, options: { future: true }, apiKey: 'fake-key' } } });
    expect(config).toEqual({ revision: 2, enabled: true, defaultProvider: null, providers: {
      parallel: { displayName: 'Parallel', enabled: true, authentication: 'anonymous', options: {}, apiKey: 'fake-key' },
    } });
  });

  it.each([
    { extra: true },
    { providers: { unknown: {} } },
    { providers: { parallel: { extra: true } } },
    { providers: { exa: { authentication: 'oauth' } } },
    { providers: { exa: { options: { unknown: true } } } },
  ])('rejects fields outside the current public write schema: %j', (patch) => {
    const base = { enabled: true, defaultProvider: 'parallel', providers: defaultWebSearchConfig().providers };
    expect(webSearchWriteSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it('publishes defaults, atomically clears a disabled selection, and restores key configuration through rollback and restart', async () => {
    const { domain, create, publish } = await fixture();
    expect(await domain.show()).toEqual(defaultWebSearchConfig());
    expect(publish).toHaveBeenCalledOnce();
    const plan = await domain.createPlan([
      { op: 'add', path: '/providers/parallel/apiKey', value: 'fake-personal-key' },
      { op: 'add', path: '/providers/parallel/authentication', value: 'api_key' },
    ]);
    expect(plan.validation.valid).toBe(true);
    await domain.apply(plan.id, 0);
    const disable = await domain.createPlan([
      { op: 'add', path: '/providers/parallel/enabled', value: false },
      { op: 'add', path: '/defaultProvider', value: null },
    ]);
    await domain.apply(disable.id, 1);
    expect(await domain.verify(2)).toMatchObject({ healthy: true });
    expect(await domain.show()).toMatchObject({ defaultProvider: null });
    await domain.rollback(1);
    const restarted = create();
    await restarted.activate();
    expect(await restarted.show()).toMatchObject({ defaultProvider: 'parallel', providers: {
      parallel: { enabled: true, authentication: 'api_key', apiKey: 'fake-personal-key' },
    } });
  });

  it('validates current selection and proxy references at the configuration boundary', async () => {
    const { domain } = await fixture();
    expect((await domain.createPlan([{ op: 'remove', path: '/providers/parallel' }])).validation.valid).toBe(false);
    expect((await domain.createPlan([{ op: 'add', path: '/providers/exa/proxyId', value: 'missing-proxy' }])).validation.valid).toBe(false);
    expect((await domain.createPlan([{ op: 'add', path: '/providers/exa/authentication', value: 'api_key' }])).validation.valid).toBe(true);
    const off = await domain.createPlan([{ op: 'add', path: '/enabled', value: false }]);
    await domain.apply(off.id, 0);
    expect(await domain.show()).toMatchObject({ enabled: false, defaultProvider: 'parallel' });
  });
});
