import type { ContextLedgerRow } from './ledger-projection';

export interface ContextTimelineRange {
  readonly start: number;
  readonly end: number;
}

export type ContextTimelineLane = 0 | 1 | 2;

export function contextTimelineLane(row: ContextLedgerRow): ContextTimelineLane {
  if (row.kind === 'tool' || isToolResult(row)) return 2;
  if (row.kind === 'message' && row.message.role === 'assistant') return 1;
  return 0;
}

export function contextTimelineKind(
  row: ContextLedgerRow,
): 'system' | 'tool' | 'user' | 'assistant' | 'result' {
  if (row.kind === 'system') return 'system';
  if (row.kind === 'tool') return 'tool';
  if (isToolResult(row)) return 'result';
  return row.message.role === 'assistant' ? 'assistant' : 'user';
}

export function contextTimelineFocusKeys(
  rows: readonly ContextLedgerRow[],
  range: ContextTimelineRange | null,
): ReadonlySet<string> | null {
  const normalized = normalizeContextTimelineRange(range, rows.length);
  if (normalized === null) return null;
  return new Set(rows.flatMap((row, index) => (
    index < normalized.end && index + 1 > normalized.start ? [row.key] : []
  )));
}

export function normalizeContextTimelineRange(
  range: ContextTimelineRange | null,
  rowCount: number,
): ContextTimelineRange | null {
  if (range === null || rowCount <= 0) return null;
  const left = Math.min(range.start, range.end);
  const right = Math.max(range.start, range.end);
  const start = Math.min(rowCount, Math.max(0, left));
  const end = Math.min(rowCount, Math.max(0, right));
  return end > start ? { start, end } : null;
}

function isToolResult(row: ContextLedgerRow): boolean {
  return row.kind === 'message'
    && Array.isArray(row.message.content)
    && row.message.content.length > 0
    && row.message.content.every((block) => block.type === 'tool_result');
}
