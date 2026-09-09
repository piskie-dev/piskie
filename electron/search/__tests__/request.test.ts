import { describe, expect, it } from 'vitest';
import type { SearchSource } from '../../../shared/types/web-search.js';
import { filterSearchSources, searchRequestSchema } from '../request.js';

describe('shared search input and source boundaries', () => {
  it('trims queries and domains while preserving valid leap dates', () => {
    expect(searchRequestSchema.parse({ query: '  sample query ',
      domains: { mode: 'include', values: [' example.org '] }, publishedAfter: '2024-02-29', publishedBefore: '2024-03-01',
    })).toEqual({ query: 'sample query', domains: { mode: 'include', values: ['example.org'] },
      publishedAfter: '2024-02-29', publishedBefore: '2024-03-01' });
  });

  it.each([
    { query: ' ' }, { publishedAfter: '2025-02-29' }, { publishedBefore: '2026-13-01' },
    { publishedAfter: '2026-01-01T00:00:00Z' }, { publishedAfter: '2026-02-02', publishedBefore: '2026-02-01' },
    { publishedAfter: '2026-02-01', publishedBefore: '2026-02-01' }, { domains: { mode: 'include', values: [] } },
    { domains: { mode: 'prefer', values: ['example.org'] } },
  ])('rejects invalid model input %j', (input) => {
    expect(searchRequestSchema.safeParse({ query: 'sample', ...input }).success).toBe(false);
  });

  it.each(['https://example.org', 'example.org/path', 'example.org:443', 'example.org?x=1', '*.example.org',
    'example.org#section', 'bad host.org', '-example.org', 'example..org', 'example.org\\path'])('rejects non-domain input %s', (domain) => {
    expect(searchRequestSchema.safeParse({ query: 'sample', domains: { mode: 'include', values: [domain] } }).success).toBe(false);
  });

  it('matches exact hosts and subdomains without matching lookalike suffixes', () => {
    const sources = ['https://EXAMPLE.org/a', 'https://docs.example.org/b', 'https://otherexample.org/c',
      'https://example.org.evil.test/d', 'https://example.net/e'].map((url) => ({ url, excerpts: [] }));
    expect(filterSearchSources(sources, { query: 'sample', domains: { mode: 'include', values: ['EXAMPLE.ORG'] } }))
      .toEqual(sources.slice(0, 2));
    expect(filterSearchSources(sources, { query: 'sample', domains: { mode: 'exclude', values: ['example.org'] } }))
      .toEqual(sources.slice(2));
  });

  it('normalizes internationalized domains', () => {
    const sources = [{ url: 'https://xn--bcher-kva.example/a', excerpts: [] }];
    expect(filterSearchSources(sources, { query: 'sample', domains: { mode: 'include', values: ['bücher.example'] } })).toEqual(sources);
  });

  it('applies inclusive lower and exclusive upper publication dates in UTC', () => {
    const dates = ['2026-02-01', '2026-02-01T00:00:00Z', '2026-02-28T23:59:59Z', '2026-03-01',
      '2026-02-01T00:00:00+01:00', '2026-03-01T00:00:00+01:00', '2026-01-31', undefined, 'unknown', '2026-02-30'];
    const sources: SearchSource[] = dates.map((publishedDate) => ({ url: 'https://example.org', excerpts: [], publishedDate }));
    expect(filterSearchSources(sources, { query: 'sample', publishedAfter: '2026-02-01', publishedBefore: '2026-03-01' }))
      .toEqual([sources[0], sources[1], sources[2], sources[5]]);
    expect(filterSearchSources(sources, { query: 'sample' })).toEqual(sources);
  });
});
