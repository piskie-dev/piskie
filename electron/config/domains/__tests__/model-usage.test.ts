import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigPlan } from '../../../../shared/types/config.js';
import { ConfigDomainRegistry } from '../../core/registry.js';
import { ConfigHost } from '../../host/config-host.js';
import { createModelUsageDomain } from '../model-usage.adapter.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('model-usage managed configuration', () => {
  it('saves retention settings, versions them and publishes before apply resolves', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-config-')); roots.push(root);
    const publish = vi.fn();
    const registry = new ConfigDomainRegistry(); registry.register(createModelUsageDomain(root, publish));
    const host = new ConfigHost(registry); await host.initialize();
    const descriptor = host.describe('model-usage');
    const field = (path: string) => descriptor.fields.find((entry) => entry.pathTemplate === path)!.fieldId;
    const plan = await host.createPlan<ConfigPlan>('model-usage', { descriptorHash: descriptor.descriptorHash,
      changes: [{ op: 'set', fieldId: field('/retentionDays'), value: 30 }] });
    expect(plan.validation.valid).toBe(true);
    await host.apply(plan.id, 0);
    expect(publish).toHaveBeenLastCalledWith({ schemaVersion: 1, revision: 1, retentionDays: 30 });
    expect(await host.verify('model-usage', 1)).toMatchObject({ healthy: true });
    await host.rollback('model-usage', 0);
    expect(await host.show('model-usage')).toEqual({ schemaVersion: 1, revision: 2, retentionDays: 90 });
    expect(await fs.readdir(path.join(root, 'config-history/model-usage'))).toHaveLength(3);
    expect(await fs.readdir(root)).not.toContain('runtime');
  });

  it('rejects unsupported retention values through the existing validation kernel', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-config-')); roots.push(root);
    const registry = new ConfigDomainRegistry(); registry.register(createModelUsageDomain(root));
    const host = new ConfigHost(registry); await host.initialize();
    const plan = await host.createPatchPlan<ConfigPlan>('model-usage', [{ op: 'replace', path: '/retentionDays', value: 7 }]);
    expect(plan.validation.valid).toBe(false);
  });

  it('reads legacy settings and saves or rolls them back without restoring retired prices', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-config-')); roots.push(root);
    const file = path.join(root, 'config/model-usage.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, revision: 0, retentionDays: 180, prices: { p: { m: { currency: 'USD', input: 1, output: 2 } } } }));
    const registry = new ConfigDomainRegistry(); registry.register(createModelUsageDomain(root));
    const host = new ConfigHost(registry); await host.initialize();
    expect(await host.show('model-usage')).toEqual({ schemaVersion: 1, revision: 0, retentionDays: 180 });
    expect(host.describe('model-usage').fields.some((field) => field.pathTemplate.startsWith('/prices'))).toBe(false);
    const plan = await host.createPatchPlan<ConfigPlan>('model-usage', [{ op: 'replace', path: '/retentionDays', value: 90 }]);
    expect(plan.validation.valid).toBe(true);
    await host.apply(plan.id, 0);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, revision: 1, retentionDays: 90 });
    await host.rollback('model-usage', 0);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, revision: 2, retentionDays: 180 });
  });
});
