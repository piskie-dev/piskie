import { describe, expect, it } from 'vitest';
import { chunkText } from '../text-utils.js';

describe('chunkText', () => {
  it('returns empty and already bounded text without rewriting it', () => {
    expect(chunkText('', 10)).toEqual([]);
    expect(chunkText('short text', 10)).toEqual(['short text']);
  });

  it('rejects limits that cannot make forward progress', () => {
    expect(() => chunkText('text', 0)).toThrow(RangeError);
    expect(() => chunkText('text', 1.5)).toThrow(RangeError);
  });

  it('prefers a line break in the latter half of the chunk window', () => {
    expect(chunkText('alpha beta\r\ngamma delta', 12)).toEqual([
      'alpha beta',
      'gamma delta',
    ]);
  });

  it('falls back to a word boundary and removes separator whitespace', () => {
    expect(chunkText('alpha beta gamma', 10)).toEqual(['alpha beta', 'gamma']);
    expect(chunkText('abcd   ef', 4)).toEqual(['abcd', 'ef']);
  });

  it('hard-splits long tokens while keeping every chunk within the limit', () => {
    const chunks = chunkText('abcdefghijk', 4);

    expect(chunks).toEqual(['abcd', 'efgh', 'ijk']);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
  });
});
