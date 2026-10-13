import { describe, expect, it } from 'vitest';
import { formatPagination, paginate } from '../pagination.js';

describe('fixed-source pagination', () => {
  const values = Array.from({ length: 43 }, (_, index) => index);
  it('returns all rows without explicit pagination options', () => {
    expect(paginate(values).items).toBe(values);
    expect(formatPagination(values, {}).info).toEqual(['Showing 1-43 of 43 (Page 1 of 1).']);
  });
  it('defaults to 20 only when pageIdx is supplied', () => {
    expect(formatPagination(values, { pageIdx: 1 })).toEqual({ items: values.slice(20, 40),
      info: ['Showing 21-40 of 43 (Page 2 of 3).', 'Next page: 2', 'Previous page: 0'] });
  });
  it('returns first-page data and ordinary text for an out-of-range page', () => {
    expect(formatPagination(values, { pageSize: 2, pageIdx: 99 })).toEqual({ items: [0, 1],
      info: ['Invalid page number provided. Showing first page.', 'Showing 1-2 of 43 (Page 1 of 22).', 'Next page: 1'] });
  });
  it('keeps the last-page range and empty-data metadata consistent', () => {
    expect(paginate(values, { pageIdx: 2 })).toMatchObject({ startIndex: 40, endIndex: 43,
      totalPages: 3, hasPreviousPage: true, hasNextPage: false });
    expect(paginate([], { pageIdx: 1 })).toMatchObject({ items: [], currentPage: 0, invalidPage: true, totalPages: 1 });
  });
});
