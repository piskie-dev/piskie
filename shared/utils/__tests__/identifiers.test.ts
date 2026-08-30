import { describe, expect, it } from 'vitest';
import { createCompactId, createUuid } from '../identifiers.js';

describe('identifier tools', () => {
  it('creates standard UUID v4 values', () => {
    expect(createUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('creates six-character base62 candidates without a domain prefix', () => {
    const values = Array.from({ length: 20 }, () => createCompactId());
    expect(values.every((value) => /^[0-9A-Za-z]{6}$/.test(value))).toBe(true);
    expect(new Set(values)).toHaveLength(values.length);
  });
});
