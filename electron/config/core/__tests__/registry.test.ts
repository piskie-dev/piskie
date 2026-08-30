import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConfigDomainAdapter } from '../../contracts/domain.js';
import { undocumentedWritableFields } from '../descriptor-builder.js';
import { ConfigDomainRegistry, ConfigDomainRegistryError } from '../registry.js';

function adapter(extensionDefault: 'safe' | 'fast' = 'safe'): ConfigDomainAdapter {
  const readSchema = z.object({
    revision: z.number().int().describe('Monotonic revision.'),
    entries: z.record(
      z.string(),
      z.object({
        name: z.string().describe('User-visible entry name.'),
      }),
    )
      .describe('Entries keyed by stable ID.')
      .meta({ 'x-piskie': { keyPlaceholder: 'entryId' } }),
  });
  const writeSchema = readSchema.omit({ revision: true });
  return {
    contract: {
      id: 'example',
      title: 'Example',
      description: 'Example configuration domain.',
      schemaVersion: 1,
      readSchema,
      writeSchema,
      capabilities: ['show', 'plan'],
      extensions: () => [{
        id: 'example-extension:one',
        kind: 'example-extension',
        title: 'Example extension',
        selector: { path: '/entries/{entryId}/kind', value: 'one' },
        schemas: [{
          name: 'options',
          path: '/entries/{entryId}/options',
          schema: z.toJSONSchema(z.object({
            mode: z.enum(['safe', 'fast']).default(extensionDefault)
              .describe('Execution mode for this extension.'),
          })) as Record<string, unknown>,
        }],
      }],
    },
    show: async () => ({}),
    history: async () => [],
    createPlan: async () => ({ id: 'plan-1', domain: 'example', baseRevision: 0 }),
  };
}

describe('ConfigDomainRegistry', () => {
  it('builds deterministic read/write fields and dynamic extension descriptors', () => {
    const registry = new ConfigDomainRegistry();
    registry.register(adapter());

    const first = registry.describe('example');
    const second = registry.describe('example');

    expect(first.descriptorHash).toBe(second.descriptorHash);
    expect(first.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldId: expect.stringMatching(/^field_[a-f0-9]{24}$/),
        pathTemplate: '/revision',
        bindings: [],
        mutability: 'read-only',
        leaf: true,
      }),
      expect.objectContaining({
        pathTemplate: '/entries/{entryId}/name',
        bindings: [{ name: 'entryId', kind: 'record-key' }],
        mutability: 'write',
        description: 'User-visible entry name.',
      }),
      expect.objectContaining({
        pathTemplate: '/entries/{entryId}/options/mode',
        extensionId: 'example-extension:one',
        enum: ['safe', 'fast'],
        default: 'safe',
      }),
    ]));
    expect(first.dynamicExtensions).toHaveLength(1);
    expect(undocumentedWritableFields(first)).toEqual([]);
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: 'example', descriptorHash: first.descriptorHash }),
    ]);
  });

  it('changes the descriptor hash when an extension contract changes', () => {
    const first = new ConfigDomainRegistry();
    const second = new ConfigDomainRegistry();
    first.register(adapter('safe'));
    second.register(adapter('fast'));
    expect(first.describe('example').descriptorHash)
      .not.toBe(second.describe('example').descriptorHash);
  });

  it('rejects duplicate and unknown domains with stable codes', () => {
    const registry = new ConfigDomainRegistry();
    registry.register(adapter());
    expect(() => registry.register(adapter())).toThrowError(expect.objectContaining<Partial<ConfigDomainRegistryError>>({
      code: 'CONFIG_DOMAIN_DUPLICATE',
    }));
    expect(() => registry.get('missing')).toThrowError(expect.objectContaining<Partial<ConfigDomainRegistryError>>({
      code: 'CONFIG_DOMAIN_NOT_FOUND',
    }));
  });

  it('rejects declared capabilities without matching Adapter methods', () => {
    const invalid = adapter();
    invalid.contract.capabilities = ['show', 'apply'];
    expect(() => new ConfigDomainRegistry().register(invalid)).toThrowError(
      expect.objectContaining<Partial<ConfigDomainRegistryError>>({
        code: 'CONFIG_DOMAIN_CONTRACT_INVALID',
      }),
    );
  });
});
