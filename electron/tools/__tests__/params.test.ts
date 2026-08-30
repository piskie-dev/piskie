import { describe, expect, it } from 'vitest';
import { bool, int, num, parse, toApiSchema, z } from '../params.js';

describe('unified parameter contract', () => {
  it('keeps model property order and omits exporter-only keys', () => {
    const schema = z.object({
      query: z.string().describe('query'),
      limit: int().default(20).describe('limit'),
      verbose: bool().optional().describe('verbose'),
    });

    const api = toApiSchema(schema);
    expect(Object.keys(api.properties as object)).toEqual(['query', 'limit', 'verbose']);
    expect(api).not.toHaveProperty('$schema');
    expect(api).not.toHaveProperty('additionalProperties');
    expect(api.required).toEqual(['query']);
    expect(api.properties).toMatchObject({
      limit: { default: 20, type: 'integer' },
    });
  });

  it('matches Ajv coercion without z.coerce edge cases', () => {
    const schema = z.object({ number: num(), integer: int(), enabled: bool() });
    expect(parse(schema, { number: '7.5', integer: '7', enabled: 'false', extra: true }))
      .toEqual({ ok: true, value: { number: 7.5, integer: 7, enabled: false } });
    expect(parse(schema, { number: '', integer: '7', enabled: 'false' }).ok).toBe(false);
    expect(parse(schema, { number: '7', integer: '7.5', enabled: 'yes' }).ok).toBe(false);
  });

  it('exports and enforces numeric constraints from the same helper contract', () => {
    const schema = z.object({ timeout: int(z.gte(1_000), z.lte(600_000)) });
    const timeout = (toApiSchema(schema).properties as Record<string, unknown>).timeout;

    expect(timeout).toMatchObject({ type: 'integer', minimum: 1_000, maximum: 600_000 });
    expect(parse(schema, { timeout: '1000' })).toEqual({ ok: true, value: { timeout: 1_000 } });
    expect(parse(schema, { timeout: '999' }).ok).toBe(false);
  });

  it('marks required preprocessed fields without making defaulted fields required', () => {
    const api = toApiSchema(z.object({
      count: int(z.positive()),
      enabled: bool().default(false),
      ratio: num().optional(),
    }));

    expect(api.required).toEqual(['count']);
    expect(api.properties).toMatchObject({ enabled: { default: false, type: 'boolean' } });
  });

  it('returns model-readable issue paths instead of throwing', () => {
    const result = parse(z.object({ file_path: z.string() }), { file_path: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('file_path:');
  });

  it('treats placeholder values as missing only for optional parameters', () => {
    const schema = z.object({
      required: z.string(),
      empty: z.string().optional(),
      whitespace: z.string().optional(),
      undefinedText: z.string().optional(),
      nullText: z.string().optional(),
      actualText: z.string().optional(),
    });
    const raw = {
      required: 'undefined',
      empty: '',
      whitespace: '   ',
      undefinedText: ' UnDeFiNeD ',
      nullText: 'NULL',
      actualText: 'none',
    };

    expect(parse(schema, raw)).toEqual({
      ok: true,
      value: { required: 'undefined', actualText: 'none' },
    });
    expect(raw).toEqual({
      required: 'undefined',
      empty: '',
      whitespace: '   ',
      undefinedText: ' UnDeFiNeD ',
      nullText: 'NULL',
      actualText: 'none',
    });
  });

  it('normalizes optional placeholders recursively while preserving arbitrary records', () => {
    const schema = z.object({
      items: z.array(z.object({
        label: z.string(),
        size: z.string().optional(),
        enabled: z.boolean().optional(),
      })),
      args: z.record(z.string(), z.unknown()).optional(),
    });

    expect(parse(schema, {
      items: [{ label: 'undefined', size: 'undefined', enabled: 'null' }],
      args: { query: 'undefined' },
    })).toEqual({
      ok: true,
      value: {
        items: [{ label: 'undefined' }],
        args: { query: 'undefined' },
      },
    });
  });
});
