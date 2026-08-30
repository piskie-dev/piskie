import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  ConfigDescriptor,
  ConfigFieldDescriptor,
} from '../../../../shared/types/config.js';
import type { ConfigDomainAdapter } from '../../contracts/domain.js';
import { buildConfigDescriptor } from '../descriptor-builder.js';
import {
  ConfigFieldChangeError,
  resolveConfigFieldChanges,
} from '../field-change-resolver.js';

function descriptor(includeNewField = false): ConfigDescriptor {
  const entry = z.strictObject({
    name: z.string().describe('Entry name.'),
    ...(includeNewField && { color: z.string().describe('Entry color.') }),
  });
  const writeSchema = z.strictObject({
    entries: z.record(z.string(), entry)
      .describe('Entries by ID.')
      .meta({ 'x-piskie': { keyPlaceholder: 'entryId' } }),
    tags: z.array(z.string().describe('Tag value.')).describe('Ordered tags.'),
  });
  const readSchema = writeSchema.extend({
    revision: z.number().int().describe('Revision.'),
    runtimeStatus: z.string().describe('Observed status.'),
  });
  const contract: ConfigDomainAdapter['contract'] = {
    id: 'example',
    title: 'Example',
    description: 'Example config.',
    schemaVersion: 1,
    readSchema,
    writeSchema,
    capabilities: ['show', 'plan'],
  };
  return buildConfigDescriptor(contract);
}

function field(current: ConfigDescriptor, pathTemplate: string): ConfigFieldDescriptor {
  const found = current.fields.find((candidate) => candidate.pathTemplate === pathTemplate);
  if (!found) throw new Error(`Missing test field: ${pathTemplate}`);
  return found;
}

describe('resolveConfigFieldChanges', () => {
  it('resolves descriptor-issued fields and safely escapes dynamic record keys', () => {
    const current = descriptor();
    const name = field(current, '/entries/{entryId}/name');

    expect(resolveConfigFieldChanges(current, {
      descriptorHash: current.descriptorHash,
      changes: [{
        op: 'set',
        fieldId: name.fieldId,
        bindings: { entryId: 'team/a~b' },
        value: 'Team A',
      }],
    })).toEqual([{
      op: 'add',
      path: '/entries/team~1a~0b/name',
      value: 'Team A',
    }]);
  });

  it('uses replace for array positions and remove for exact resolved targets', () => {
    const current = descriptor();
    const tag = field(current, '/tags/{index}');

    expect(resolveConfigFieldChanges(current, {
      descriptorHash: current.descriptorHash,
      changes: [
        { op: 'set', fieldId: tag.fieldId, bindings: { index: 1 }, value: 'next' },
      ],
    })).toEqual([{ op: 'replace', path: '/tags/1', value: 'next' }]);
    expect(resolveConfigFieldChanges(current, {
      descriptorHash: current.descriptorHash,
      changes: [
        { op: 'remove', fieldId: tag.fieldId, bindings: { index: 1 } },
      ],
    })).toEqual([{ op: 'remove', path: '/tags/1' }]);
  });

  it('rejects guessed IDs, stale Descriptors, read-only fields, and guessed bindings', () => {
    const current = descriptor();
    const name = field(current, '/entries/{entryId}/name');
    const status = field(current, '/runtimeStatus');

    const cases: Array<{ request: unknown; code: ConfigFieldChangeError['code'] }> = [
      {
        request: {
          descriptorHash: current.descriptorHash,
          changes: [{ op: 'set', fieldId: 'field_guessed', value: true }],
        },
        code: 'CONFIG_FIELD_NOT_FOUND',
      },
      {
        request: {
          descriptorHash: current.descriptorHash,
          changes: [{ op: 'set', path: '/entries/a/name', value: 'A' }],
        },
        code: 'CONFIG_CHANGE_INVALID',
      },
      {
        request: {
          descriptorHash: 'stale',
          changes: [{ op: 'set', fieldId: name.fieldId, bindings: { entryId: 'a' }, value: 'A' }],
        },
        code: 'CONFIG_DESCRIPTOR_CHANGED',
      },
      {
        request: {
          descriptorHash: current.descriptorHash,
          changes: [{ op: 'set', fieldId: status.fieldId, value: 'fake' }],
        },
        code: 'CONFIG_FIELD_NOT_WRITABLE',
      },
      {
        request: {
          descriptorHash: current.descriptorHash,
          changes: [{ op: 'set', fieldId: name.fieldId, bindings: { guessedId: 'a' }, value: 'A' }],
        },
        code: 'CONFIG_FIELD_BINDINGS_INVALID',
      },
    ];

    for (const { request, code } of cases) {
      expect(() => resolveConfigFieldChanges(current, request)).toThrowError(
        expect.objectContaining<Partial<ConfigFieldChangeError>>({ code }),
      );
    }
  });

  it('accepts a newly declared field without adding resolver code or a field table', () => {
    const current = descriptor(true);
    const color = field(current, '/entries/{entryId}/color');

    expect(resolveConfigFieldChanges(current, {
      descriptorHash: current.descriptorHash,
      changes: [{
        op: 'set',
        fieldId: color.fieldId,
        bindings: { entryId: 'new-entry' },
        value: 'orange',
      }],
    })).toEqual([{
      op: 'add',
      path: '/entries/new-entry/color',
      value: 'orange',
    }]);
  });
});
