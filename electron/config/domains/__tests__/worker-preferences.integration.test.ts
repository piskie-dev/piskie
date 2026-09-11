import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigPlan, ConfigPatchOperation } from '../../../../shared/types/config.js';
import type { WorkerPreferencesDocument } from '../../../../shared/types/worker-preferences.js';
import { InferenceControlPlane } from '../../../inference/control/control-plane.js';
import { InferenceConfigRepository, inferenceConfigPaths } from '../../../inference/control/config-repository.js';
import { InferenceSelectionStore } from '../../../inference/control/selection-store.js';
import { testConfig, testModel } from '../../../inference/control/__tests__/fixtures.js';
import { createFakeDriver } from '../../../inference/control/__tests__/fake-driver.js';
import { DriverRegistry } from '../../../inference/drivers/registry.js';
import { createConfigHost } from '../../host/composition.js';
import { emptyConfigDomainIntegrations } from '../integrations.js';
import { configDomainStoragePaths } from '../../core/storage-layout.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const target = { providerId: 'primary', modelId: 'chat' };
const preference = { inference: { target, reasoning: { kind: 'effort', effort: 'low' } } } as const;

async function fixture(withTypes = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-worker-preferences-'));
  directories.push(root);
  await fs.mkdir(path.join(root, 'catalog'), { recursive: true });
  await fs.writeFile(path.join(root, 'catalog/models.json'), JSON.stringify({ version: 'base-1', models: [testModel({
    reasoning: { mode: 'effort', options: [{ kind: 'effort', effort: 'low' }, { kind: 'effort', effort: 'high' }],
      defaultSelection: { kind: 'effort', effort: 'high' }, mandatory: true, transportPreset: 'openai-effort', replayPolicy: 'none' },
  })] }));
  const paths = inferenceConfigPaths(root);
  const repository = new InferenceConfigRepository(paths);
  await repository.initialize(testConfig());
  const drivers = new DriverRegistry();
  drivers.register(createFakeDriver());
  const control = new InferenceControlPlane({ repository, drivers });
  const types = [{ type: 'explore', description: 'Explore' }, { type: 'browser-worker', description: 'Browser' }];
  const host = createConfigHost({ rootDirectory: root, inference: control, selections: new InferenceSelectionStore(paths),
    integrations: { ...emptyConfigDomainIntegrations(), ...(withTypes && { workerPreferences: { listTypes: () => types } }) } });
  await host.initialize();
  const plan = (patch: ConfigPatchOperation[]) => host.createPatchPlan<ConfigPlan>('worker-preferences', patch);
  const save = async (type = 'explore', value: unknown = preference, revision = 0) => {
    const pending = await plan([{ op: 'add', path: `/profiles/${type}`, value }]);
    expect(pending.validation).toMatchObject({ valid: true });
    await host.apply(pending.id, revision);
    return pending;
  };
  return { root, host, types, control, plan, save };
}

describe('Worker preferences through the Node ConfigHost', () => {
  it('persists display-only remarks through strict descriptor fields and allows removing them', async () => {
    const { host, plan, save } = await fixture();
    for (const displayName of ['', '   ', 'x'.repeat(81), 1, { name: 'Example' }]) {
      expect((await plan([{ op: 'add', path: '/profiles/explore', value: { displayName } }])).validation.valid).toBe(false);
    }
    await save('explore', { displayName: '  Code review  ' });
    expect((await host.show<WorkerPreferencesDocument>('worker-preferences')).profiles).toEqual({ explore: { displayName: 'Code review' } });
    const descriptor = host.describe('worker-preferences');
    const field = descriptor.fields.find((field) => field.pathTemplate === '/profiles/{type}/displayName')!;
    const update = await host.createPlan<ConfigPlan>('worker-preferences', {
      descriptorHash: descriptor.descriptorHash,
      changes: [{ op: 'set', fieldId: field.fieldId, bindings: { type: 'explore' }, value: 'Investigation' }],
    });
    expect(update.validation.valid).toBe(true);
    await host.apply(update.id, 1);
    expect((await host.show<WorkerPreferencesDocument>('worker-preferences')).profiles.explore).toEqual({ displayName: 'Investigation' });
    const clear = await plan([{ op: 'remove', path: '/profiles/explore/displayName' }]);
    await host.apply(clear.id, 2);
    expect((await host.show<WorkerPreferencesDocument>('worker-preferences')).profiles.explore).toEqual({});
  });

  it('allows remark-only edits without changing an existing unavailable model', async () => {
    const { root, host, plan } = await fixture();
    const inference = { target: { providerId: 'missing', modelId: 'gone' }, reasoning: { kind: 'provider-default' } };
    await fs.writeFile(configDomainStoragePaths(root, 'worker-preferences').configFile, JSON.stringify({ schemaVersion: 1, revision: 0, profiles: { explore: { inference } } }));
    const pending = await plan([{ op: 'add', path: '/profiles/explore/displayName', value: 'Needs repair' }]);
    expect(pending.validation.valid).toBe(true);
    expect(pending.validation.issues).toContainEqual(expect.objectContaining({ code: 'WORKER_MODEL_UNAVAILABLE', severity: 'warning' }));
    await host.apply(pending.id, 0);
    expect((await host.show<WorkerPreferencesDocument>('worker-preferences')).profiles.explore).toEqual({ inference, displayName: 'Needs repair' });
  });

  it('loads without Electron and persists concrete type preferences through descriptor-bound fields', async () => {
    const { host } = await fixture();
    expect(await host.show('worker-preferences')).toEqual({ schemaVersion: 1, revision: 0, profiles: {} });
    const descriptor = host.describe('worker-preferences');
    const field = descriptor.fields.find((entry) => entry.pathTemplate === '/profiles/{type}')!;
    const plan = await host.createPlan<ConfigPlan>('worker-preferences', { descriptorHash: descriptor.descriptorHash,
      changes: [{ op: 'set', fieldId: field.fieldId, bindings: { type: 'explore' }, value: preference }] });
    expect(plan.validation.valid).toBe(true);
    await host.apply(plan.id, 0);
    expect(await host.show('worker-preferences')).toMatchObject({ revision: 1, profiles: { explore: preference } });
    expect(await host.verify('worker-preferences', 1)).toMatchObject({ healthy: true });
    await host.rollback('worker-preferences', 0);
    expect(await host.show('worker-preferences')).toMatchObject({ revision: 2, profiles: {} });
  });

  it('rejects undeclared nested fields and invalid concrete reasoning but strips unknown persisted fields', async () => {
    const { root, host, plan } = await fixture();
    for (const value of [
      { ...preference, unexpected: true },
      { inference: { ...preference.inference, reasoning: { ...preference.inference.reasoning, unexpected: true } } },
      { inference: { target, reasoning: { kind: 'budget', tokens: 1.5 } } },
      { inference: { target, reasoning: { kind: 'effort', effort: 'max' } } },
      { inference: { target } },
    ]) expect((await plan([{ op: 'add', path: '/profiles/explore', value }])).validation.valid).toBe(false);
    const file = configDomainStoragePaths(root, 'worker-preferences').configFile;
    const raw = JSON.stringify({ schemaVersion: 1, revision: 0, unexpected: true, profiles: {
      explore: { inference: { ...preference.inference, reasoning: { ...preference.inference.reasoning, unexpected: true } } },
    } });
    await fs.writeFile(file, raw);
    expect(await host.show('worker-preferences')).toEqual({ schemaVersion: 1, revision: 0, profiles: { explore: preference } });
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
  });

  it('uses the injected catalog dynamically and distinguishes a missing catalog', async () => {
    const { types, plan, save } = await fixture();
    expect((await plan([{ op: 'add', path: '/profiles/future-worker', value: preference }])).validation.issues)
      .toContainEqual(expect.objectContaining({ code: 'WORKER_TYPE_NOT_FOUND' }));
    types.push({ type: 'future-worker', description: 'Registered later' });
    await save('future-worker');
    const standalone = await fixture(false);
    expect((await standalone.plan([{ op: 'add', path: '/profiles/explore', value: preference }])).validation.issues)
      .toContainEqual(expect.objectContaining({ code: 'WORKER_CATALOG_UNAVAILABLE' }));
  });

  it('retains stale references as diagnostics while allowing unrelated saves and cleanup', async () => {
    const { root, host, save, plan } = await fixture();
    await fs.writeFile(configDomainStoragePaths(root, 'worker-preferences').configFile, JSON.stringify({ schemaVersion: 1, revision: 0,
      profiles: { removed: { inference: { target: { providerId: 'missing', modelId: 'gone' }, reasoning: { kind: 'provider-default' } } } },
    }));
    const saved = await save();
    expect(saved.validation.issues.every((issue) => issue.severity === 'warning')).toBe(true);
    const cleanup = await plan([{ op: 'remove', path: '/profiles/removed' }]);
    expect(cleanup.validation).toEqual({ valid: true, issues: [] });
    await host.apply(cleanup.id, 1);
    expect((await host.show<WorkerPreferencesDocument>('worker-preferences')).profiles).toEqual({ explore: preference });
    await expect(host.rollback('worker-preferences', 1)).rejects.toThrow();
  });

  it('rejects stale plans without overwriting another type', async () => {
    const { host, plan, save } = await fixture();
    const pending = await plan([{ op: 'add', path: '/profiles/explore', value: preference }]);
    await save('browser-worker');
    await expect(host.apply(pending.id, 0)).rejects.toThrow();
    expect((await host.show<WorkerPreferencesDocument>('worker-preferences')).profiles).toEqual({ 'browser-worker': preference });
  });

  it('protects referenced targets and checks dependency revisions before committing', async () => {
    const { host, plan, save } = await fixture();
    await save();
    for (const patch of [
      [{ op: 'replace' as const, path: '/providers/primary/enabled', value: false }],
      [{ op: 'remove' as const, path: '/providers/primary/models/chat' }],
    ]) {
      const blocked = await host.createPatchPlan<ConfigPlan>('inference', patch);
      expect(blocked.validation.issues).toContainEqual(expect.objectContaining({ code: 'WORKER_MODEL_UNAVAILABLE', severity: 'error' }));
      expect(blocked.impacts).toContainEqual(expect.objectContaining({ code: 'WORKER_MODEL_UNAVAILABLE', severity: 'high' }));
    }
    const catalogEntry: Omit<ReturnType<typeof testModel>, 'source'> & { source?: unknown } = { ...testModel() };
    delete catalogEntry.source;
    const capabilityChange = await host.createPatchPlan<ConfigPlan>('model-catalog', [{ op: 'add', path: '/models/custom~1chat', value: {
      ...catalogEntry,
      limits: { contextWindow: 50_000 },
      reasoning: { mode: 'fixed', options: [{ kind: 'enabled' }], defaultSelection: { kind: 'enabled' },
        mandatory: true, transportPreset: 'deepseek-thinking', replayPolicy: 'none' },
    } }]);
    expect(capabilityChange.validation.issues).toContainEqual(expect.objectContaining({ code: 'WORKER_REASONING_UNSUPPORTED' }));
    const pending = await plan([{ op: 'add', path: '/profiles/browser-worker', value: preference }]);
    const rename = await host.createPatchPlan<ConfigPlan>('inference', [{ op: 'replace', path: '/providers/primary/displayName', value: 'Renamed' }]);
    expect(rename.validation.valid).toBe(true);
    await host.apply(rename.id, 0);
    const stale = await host.validate<ConfigPlan>(pending.id);
    expect(stale.validation.issues).toContainEqual(expect.objectContaining({ code: 'CONFIG_DEPENDENCY_REVISION_CHANGED' }));
    await expect(host.apply(pending.id, 1)).rejects.toThrow();
  });
});
