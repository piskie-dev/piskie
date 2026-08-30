import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sha256Canonical } from '../file-plan-store.js';
import { projectConfigWrite } from '../schema-write-projector.js';

describe('projectConfigWrite', () => {
  it('recursively removes read-only fields from objects, records, arrays, and unions', () => {
    const entrySchema = z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('text'),
        value: z.string(),
      }),
      z.strictObject({
        kind: z.literal('number'),
        value: z.number(),
      }),
    ]);
    const writeSchema = z.strictObject({
      feature: z.strictObject({
        enabled: z.boolean(),
        label: z.string().optional(),
      }),
      entries: z.record(z.string(), entrySchema),
      rows: z.array(z.strictObject({ value: z.string() })),
      freeform: z.record(z.string(), z.unknown()),
    });

    expect(projectConfigWrite(writeSchema, {
      revision: 7,
      runtimeStatus: 'ready',
      feature: { enabled: true, label: 'New field', observedAt: 123 },
      entries: {
        first: { kind: 'text', value: 'hello', createdAt: 1 },
        second: { kind: 'number', value: 42, createdAt: 2 },
      },
      rows: [{ value: 'row', runtimeStatus: 'busy' }],
      freeform: { nested: { valuesRemainOpaque: true, status: 'kept' } },
    })).toEqual({
      feature: { enabled: true, label: 'New field' },
      entries: {
        first: { kind: 'text', value: 'hello' },
        second: { kind: 'number', value: 42 },
      },
      rows: [{ value: 'row' }],
      freeform: { nested: { valuesRemainOpaque: true, status: 'kept' } },
    });
  });

  it('automatically includes a newly declared optional field', () => {
    const stored = {
      revision: 3,
      settings: {
        name: 'Example',
        color: 'orange',
        observedState: 'running',
      },
    };
    const originalSchema = z.strictObject({
      settings: z.strictObject({ name: z.string() }),
    });
    const extendedSchema = z.strictObject({
      settings: z.strictObject({
        name: z.string(),
        color: z.string().optional(),
      }),
    });

    expect(projectConfigWrite(originalSchema, stored)).toEqual({
      settings: { name: 'Example' },
    });
    expect(projectConfigWrite(extendedSchema, stored)).toEqual({
      settings: { name: 'Example', color: 'orange' },
    });
  });

  it('omits undefined object properties before producing JSON-backed configuration', () => {
    const writeSchema = z.strictObject({
      flows: z.record(z.string(), z.strictObject({
        name: z.string(),
        workspace: z.string().optional(),
        metadata: z.unknown().optional(),
      })),
    });

    const projected = projectConfigWrite(writeSchema, {
      flows: {
        custom: {
          name: 'Custom task',
          workspace: undefined,
          metadata: {
            type: 'standard',
            boundEnvironmentIds: undefined,
            enabled: false,
          },
        },
      },
    });

    expect(projected).toEqual({
      flows: {
        custom: {
          name: 'Custom task',
          metadata: { type: 'standard', enabled: false },
        },
      },
    });
    expect(() => sha256Canonical(projected)).not.toThrow();
  });

  it('does not turn undefined array entries into valid JSON values', () => {
    const writeSchema = z.strictObject({ values: z.array(z.string()) });

    expect(() => projectConfigWrite(writeSchema, { values: [undefined] })).toThrow();
  });

  it('selects discriminated-union branches without combinatorial expansion', () => {
    const entrySchema = z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('text'), value: z.string() }),
      z.strictObject({ kind: z.literal('number'), value: z.number() }),
    ]);
    const writeSchema = z.strictObject({
      entries: z.record(z.string(), entrySchema),
    });
    const entries = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      `entry-${index}`,
      index % 2 === 0
        ? { kind: 'text', value: `value-${index}`, runtimeStatus: 'ready' }
        : { kind: 'number', value: index, runtimeStatus: 'ready' },
    ]));

    const projected = projectConfigWrite(writeSchema, { revision: 1, entries });

    expect(Object.keys(projected.entries)).toHaveLength(20);
    expect(projected.entries['entry-0']).toEqual({ kind: 'text', value: 'value-0' });
    expect(projected.entries['entry-19']).toEqual({ kind: 'number', value: 19 });
  });
});
