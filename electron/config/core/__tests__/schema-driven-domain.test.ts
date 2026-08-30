import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ConfigPlan } from '../../../../shared/types/config.js';
import { createManagedDomain } from '../../domains/domain-factory.js';
import { ConfigHost } from '../../host/config-host.js';
import { ConfigDomainRegistry } from '../registry.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('schema-driven Config Domain fields', () => {
  it('describes, resolves, plans, and persists a new field without a write projector', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-schema-domain-'));
    temporaryDirectories.push(root);

    const itemWriteSchema = z.strictObject({
      name: z.string().describe('Item name.'),
      color: z.string().describe('New optional item color.').optional(),
    });
    const writeSchema = z.strictObject({
      items: z.record(z.string(), itemWriteSchema)
        .describe('Items keyed by ID.')
        .meta({ 'x-piskie': { keyPlaceholder: 'itemId' } }),
    });
    const itemStoredSchema = itemWriteSchema.extend({ createdAt: z.number() });
    const readSchema = z.strictObject({
      revision: z.number().int().nonnegative().describe('Monotonic revision.'),
      items: z.record(z.string(), itemStoredSchema)
        .describe('Items keyed by ID.')
        .meta({ 'x-piskie': { keyPlaceholder: 'itemId' } }),
    });
    type Stored = z.infer<typeof readSchema>;
    type Read = Stored;
    type Write = z.infer<typeof writeSchema>;

    const domain = createManagedDomain<Stored, Read, Write>(root, {
      contract: {
        id: 'synthetic',
        title: 'Synthetic config',
        description: 'Proves field-level config wiring is schema-driven.',
        schemaVersion: 1,
        readSchema,
        writeSchema,
        capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
      },
      codec: { parse: (raw) => readSchema.parse(raw) },
      bootstrap: () => ({
        revision: 0,
        items: { primary: { name: 'Primary', createdAt: 100 } },
      }),
      adapter: {
        projectRead: (stored) => stored,
        normalizeCandidate: (current, patched) => ({
          ...patched,
          revision: current.revision,
          items: Object.fromEntries(Object.entries(patched.items).map(([id, item]) => [id, {
            ...item,
            createdAt: current.items[id]?.createdAt ?? 200,
          }])),
        }),
        publish: () => undefined,
      },
    });
    const registry = new ConfigDomainRegistry();
    registry.register(domain);
    const host = new ConfigHost(registry);
    await host.initialize();

    const descriptor = host.describe('synthetic');
    const color = descriptor.fields.find((field) => (
      field.pathTemplate === '/items/{itemId}/color'
    ));
    expect(color).toBeDefined();

    const plan = await host.createPlan<ConfigPlan>('synthetic', {
      descriptorHash: descriptor.descriptorHash,
      changes: [{
        op: 'set',
        fieldId: color!.fieldId,
        bindings: { itemId: 'primary' },
        value: 'orange',
      }],
    });
    expect(plan.candidate).toEqual({
      items: { primary: { name: 'Primary', color: 'orange' } },
    });
    expect(plan.validation).toEqual({ valid: true, issues: [] });

    await host.apply(plan.id, 0);
    await expect(host.show('synthetic')).resolves.toEqual({
      revision: 1,
      items: { primary: { name: 'Primary', color: 'orange', createdAt: 100 } },
    });
  });

  it('rejects a Domain normalizer that silently drops a writable field', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-lossy-domain-'));
    temporaryDirectories.push(root);

    const writeSchema = z.strictObject({
      name: z.string().describe('Configuration name.'),
      newField: z.string().describe('New optional field.').optional(),
    });
    const readSchema = writeSchema.extend({
      revision: z.number().int().nonnegative().describe('Monotonic revision.'),
    });
    type Stored = z.infer<typeof readSchema>;
    type Write = z.infer<typeof writeSchema>;
    const domain = createManagedDomain<Stored, Stored, Write>(root, {
      contract: {
        id: 'lossy',
        title: 'Lossy config',
        description: 'Exercises the write-projection invariant.',
        schemaVersion: 1,
        readSchema,
        writeSchema,
        capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
      },
      codec: { parse: (raw) => readSchema.parse(raw) },
      bootstrap: () => ({ revision: 0, name: 'Example', newField: 'before' }),
      adapter: {
        projectRead: (stored) => stored,
        normalizeCandidate: (current, patched) => ({
          revision: current.revision,
          name: patched.name,
        }),
        publish: () => undefined,
      },
    });
    const registry = new ConfigDomainRegistry();
    registry.register(domain);
    const host = new ConfigHost(registry);
    await host.initialize();

    const plan = await host.createPatchPlan<ConfigPlan>('lossy', [{
      op: 'replace',
      path: '/newField',
      value: 'after',
    }]);

    expect(plan.validation).toMatchObject({
      valid: false,
      issues: [{ code: 'CONFIG_WRITE_PROJECTION_MISMATCH' }],
    });
    await expect(host.show('lossy')).resolves.toMatchObject({ newField: 'before' });
  });

  it('applies a valid plan that contains non-blocking item diagnostics', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-diagnostic-domain-'));
    temporaryDirectories.push(root);
    const writeSchema = z.strictObject({ value: z.string().describe('Synthetic value.') });
    const readSchema = writeSchema.extend({
      revision: z.number().int().nonnegative().describe('Monotonic revision.'),
    });
    type Stored = z.infer<typeof readSchema>;
    type Write = z.infer<typeof writeSchema>;
    const publish = vi.fn();
    const domain = createManagedDomain<Stored, Stored, Write>(root, {
      contract: {
        id: 'diagnostic',
        title: 'Diagnostic config',
        description: 'Proves warnings do not reject unrelated valid configuration.',
        schemaVersion: 1,
        readSchema,
        writeSchema,
        capabilities: ['show', 'plan', 'validate', 'apply'],
      },
      codec: { parse: (raw) => readSchema.parse(raw) },
      bootstrap: () => ({ revision: 0, value: 'before' }),
      adapter: {
        projectRead: async (stored) => stored,
        normalizeCandidate: (current, patched) => ({ ...patched, revision: current.revision }),
        validateSemantic: () => ({
          valid: true,
          issues: [{
            stage: 'semantic',
            code: 'ITEM_IGNORED',
            path: '/items/broken',
            message: 'One unrelated item is unavailable.',
            severity: 'warning',
          }],
        }),
        publish,
      },
    });
    const registry = new ConfigDomainRegistry();
    registry.register(domain);
    const host = new ConfigHost(registry);
    await host.initialize();

    const plan = await host.createPatchPlan<ConfigPlan>('diagnostic', [{
      op: 'replace',
      path: '/value',
      value: 'after',
    }]);

    expect(plan.validation).toMatchObject({
      valid: true,
      issues: [{ code: 'ITEM_IGNORED', severity: 'warning' }],
    });
    await expect(host.apply(plan.id, 0)).resolves.toMatchObject({ revision: 1 });
    await expect(host.show('diagnostic')).resolves.toMatchObject({ value: 'after' });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('loads incomplete records but strictly validates only records written by a patch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-read-wide-domain-'));
    temporaryDirectories.push(root);

    const readItemSchema = z.strictObject({
      name: z.string(),
      requiredKey: z.string().optional(),
    });
    const writeItemSchema = z.strictObject({
      name: z.string(),
      requiredKey: z.string(),
    });
    const readSchema = z.strictObject({
      revision: z.number().int().nonnegative(),
      optionalSelection: z.strictObject({ id: z.string() }).optional(),
      items: z.record(z.string(), readItemSchema),
    });
    const writeSchema = z.strictObject({
      optionalSelection: z.strictObject({ id: z.string() }).optional(),
      items: z.record(z.string(), writeItemSchema),
    });
    type Stored = z.infer<typeof readSchema>;
    type Write = z.infer<typeof writeSchema>;

    const domain = createManagedDomain<Stored, Stored, Write>(root, {
      contract: {
        id: 'read-wide',
        title: 'Read-wide config',
        description: 'Exercises generic read-wide and node-level write-strict behavior.',
        schemaVersion: 1,
        readSchema,
        writeSchema,
        capabilities: ['show', 'plan', 'validate', 'apply', 'history', 'rollback'],
      },
      codec: { parse: (raw) => readSchema.parse(raw) },
      bootstrap: () => ({
        revision: 0,
        optionalSelection: { id: 'selected' },
        items: {
          incomplete: { name: 'Incomplete' },
          complete: { name: 'Complete', requiredKey: 'present' },
        },
      }),
      adapter: {
        projectRead: (stored) => stored,
        normalizeCandidate: (current, patched) => ({ ...patched, revision: current.revision }),
        publish: () => undefined,
      },
    });
    const registry = new ConfigDomainRegistry();
    registry.register(domain);
    const host = new ConfigHost(registry);
    await host.initialize();

    await expect(host.show('read-wide')).resolves.toMatchObject({
      items: { incomplete: { name: 'Incomplete' } },
    });

    const editSibling = await host.createPatchPlan<ConfigPlan>('read-wide', [{
      op: 'replace', path: '/items/complete/name', value: 'Changed',
    }]);
    expect(editSibling.validation).toEqual({ valid: true, issues: [] });
    await host.apply(editSibling.id, 0);

    const clearOptionalSelection = await host.createPatchPlan<ConfigPlan>('read-wide', [{
      op: 'remove', path: '/optionalSelection',
    }]);
    expect(clearOptionalSelection.validation).toEqual({ valid: true, issues: [] });

    const addNestedField = await host.createPatchPlan<ConfigPlan>('read-wide', [{
      op: 'add', path: '/items/incomplete/requiredKey', value: 'repaired in place',
    }]);
    expect(addNestedField.validation).toEqual({ valid: true, issues: [] });

    const invalidRewrite = await host.createPatchPlan<ConfigPlan>('read-wide', [{
      op: 'replace', path: '/items/incomplete', value: { name: 'Still incomplete' },
    }]);
    expect(invalidRewrite.validation).toMatchObject({
      valid: false,
      issues: [{ path: '/items/incomplete/requiredKey' }],
    });

    const deleteIncomplete = await host.createPatchPlan<ConfigPlan>('read-wide', [{
      op: 'remove', path: '/items/incomplete',
    }]);
    expect(deleteIncomplete.validation).toEqual({ valid: true, issues: [] });

    const removeRequiredKey = await host.createPatchPlan<ConfigPlan>('read-wide', [{
      op: 'remove', path: '/items/complete/requiredKey',
    }]);
    expect(removeRequiredKey.validation).toMatchObject({
      valid: false,
      issues: [{ path: '/items/complete/requiredKey' }],
    });

    const repaired = await host.createPatchPlan<ConfigPlan>('read-wide', [{
      op: 'replace',
      path: '/items/incomplete',
      value: { name: 'Repaired', requiredKey: 'now present' },
    }]);
    expect(repaired.validation).toEqual({ valid: true, issues: [] });

    await expect(host.rollback('read-wide', 0)).rejects.toMatchObject({
      code: 'CONFIG_VALIDATION_FAILED',
      details: {
        validation: {
          issues: [{ path: '/items/incomplete/requiredKey' }],
        },
      },
    });
  });
});
