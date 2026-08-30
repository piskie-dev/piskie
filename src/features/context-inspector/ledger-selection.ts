import type { Message } from '@shared/types';
import type { ContextLedgerRow } from './ledger-projection';

export function resolveContextLedgerSelection(
  rows: readonly ContextLedgerRow[],
  selected: ContextLedgerRow | null,
): ContextLedgerRow | null {
  if (selected === null) return null;

  const currentGenerationMatch = rows.find((row) => row.key === selected.key);
  if (currentGenerationMatch) return currentGenerationMatch;

  if (selected.kind === 'system') {
    return rows.find((row) => row.kind === 'system') ?? null;
  }
  if (selected.kind === 'tool') {
    return rows.find((row) => row.kind === 'tool' && row.tool.name === selected.tool.name) ?? null;
  }

  const candidate = rows.find((row) => (
    row.kind === 'message' && row.messageIndex === selected.messageIndex
  ));
  return candidate?.kind === 'message' && sameMessage(candidate.message, selected.message)
    ? candidate
    : null;
}

function sameMessage(left: Message, right: Message): boolean {
  return left.role === right.role
    && left.subtype === right.subtype
    && sameStructuredValue(left.content, right.content);
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameStructuredValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(right, key)
      && sameStructuredValue(left[key], right[key])
    ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
