/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.7.0 src/utils/pagination.ts.
 */

export interface PaginationOptions {
  readonly pageSize?: number;
  readonly pageIdx?: number;
}

export interface PaginationResult<Item> {
  readonly items: readonly Item[];
  readonly currentPage: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly invalidPage: boolean;
}

const DEFAULT_PAGE_SIZE = 20;

export function paginate<Item>(
  items: readonly Item[],
  options?: PaginationOptions,
): PaginationResult<Item> {
  const total = items.length;
  if (!options || (options.pageSize === undefined && options.pageIdx === undefined)) {
    return {
      items,
      currentPage: 0,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: total,
      invalidPage: false,
    };
  }

  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = options.pageIdx;
  const invalidPage = requestedPage !== undefined
    && (requestedPage < 0 || requestedPage >= totalPages);
  const currentPage = requestedPage === undefined || invalidPage ? 0 : requestedPage;
  const startIndex = currentPage * pageSize;
  const pageItems = items.slice(startIndex, startIndex + pageSize);
  const endIndex = startIndex + pageItems.length;

  return {
    items: pageItems,
    currentPage,
    totalPages,
    hasNextPage: currentPage < totalPages - 1,
    hasPreviousPage: currentPage > 0,
    startIndex,
    endIndex,
    invalidPage,
  };
}

export function formatPagination<Item>(
  items: readonly Item[],
  options?: PaginationOptions,
): Readonly<{ items: readonly Item[]; info: readonly string[] }> {
  const result = paginate(items, options);
  const info: string[] = [];
  if (result.invalidPage) info.push('Invalid page number provided. Showing first page.');
  info.push(
    `Showing ${result.startIndex + 1}-${result.endIndex} of ${items.length} `
    + `(Page ${result.currentPage + 1} of ${result.totalPages}).`,
  );
  if (options && result.hasNextPage) info.push(`Next page: ${result.currentPage + 1}`);
  if (options && result.hasPreviousPage) info.push(`Previous page: ${result.currentPage - 1}`);
  return { items: result.items, info };
}
