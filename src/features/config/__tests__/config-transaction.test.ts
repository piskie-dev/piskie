import { describe, expect, it, vi } from 'vitest';
import type { ConfigDescriptor, ConfigValidationIssue } from '../../../../shared/types/config';
import { ConfigValidationError } from '../config-validation-error';
import {
  applyConfigFieldChanges,
  createConfigPlanRequest,
} from '../config-transaction';

const descriptor: ConfigDescriptor = {
  domain: 'example',
  title: 'Example',
  description: 'Example config.',
  schemaVersion: 1,
  descriptorHash: 'descriptor-example',
  capabilities: ['show', 'plan', 'validate', 'apply', 'verify'],
  readSchema: {},
  writeSchema: {},
  fields: [{
    fieldId: 'field_name',
    pathTemplate: '/entries/{entryId}/name',
    bindings: [{ name: 'entryId', kind: 'record-key' }],
    source: 'domain',
    leaf: true,
    required: true,
    mutability: 'write',
  }],
  dynamicExtensions: [],
};

describe('config transaction client', () => {
  it('binds UI field templates to discovered field IDs', () => {
    expect(createConfigPlanRequest(descriptor, [{
      op: 'set',
      pathTemplate: '/entries/{entryId}/name',
      bindings: { entryId: 'entry/a' },
      value: 'Next',
    }])).toEqual({
      descriptorHash: 'descriptor-example',
      changes: [{
        op: 'set',
        fieldId: 'field_name',
        bindings: { entryId: 'entry/a' },
        value: 'Next',
      }],
    });
  });

  it('runs Plan, validation, CAS apply, and verification through ConfigClient', async () => {
    const config = {
      plan: vi.fn(async () => ({
        id: 'plan-1', domain: 'example', baseRevision: 4,
      })),
      validate: vi.fn(async () => ({
        id: 'plan-1',
        domain: 'example',
        baseRevision: 4,
        validation: { valid: true, issues: [] },
      })),
      apply: vi.fn(async () => ({
        domain: 'example', revision: 5, previousRevision: 4,
      })),
      verify: vi.fn(async () => ({
        domain: 'example', healthy: true, issues: [],
      })),
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { piskie: { configuration: config } },
    });

    await expect(applyConfigFieldChanges('example', descriptor, 4, [{
      op: 'set',
      pathTemplate: '/entries/{entryId}/name',
      bindings: { entryId: 'entry-a' },
      value: 'Next',
    }])).resolves.toMatchObject({ receipt: { revision: 5 } });

    expect(config.plan).toHaveBeenCalledWith('example', expect.objectContaining({
      descriptorHash: 'descriptor-example',
    }));
    expect(config.validate).toHaveBeenCalledWith('plan-1');
    expect(config.apply).toHaveBeenCalledWith('plan-1', 4);
    expect(config.verify).toHaveBeenCalledWith('example', 5);
  });

  it('preserves validation codes and details while rejecting the write', async () => {
    const issues: ConfigValidationIssue[] = [{
      stage: 'reference', code: 'EXAMPLE_REFERENCE', path: '/entries/entry-a',
      message: 'The entry is referenced.', details: { owner: 'example' },
    }];
    const config = {
      plan: vi.fn(async () => ({ id: 'plan-1', domain: 'example', baseRevision: 4 })),
      validate: vi.fn(async () => ({ validation: { valid: false, issues } })),
      apply: vi.fn(),
      verify: vi.fn(),
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { piskie: { configuration: config } },
    });

    const error = await applyConfigFieldChanges('example', descriptor, 4, [{
      op: 'set', pathTemplate: '/entries/{entryId}/name',
      bindings: { entryId: 'entry-a' }, value: 'Next',
    }]).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error).toMatchObject({ domain: 'example', code: 'EXAMPLE_REFERENCE', issues });
    expect(config.apply).not.toHaveBeenCalled();
    expect(config.verify).not.toHaveBeenCalled();
  });
});
