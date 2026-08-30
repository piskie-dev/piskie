import { describe, expect, it } from 'vitest';
import type { ContextSnapshot } from '@shared/types/token';
import { projectContextLedger, type ContextLedgerRow } from '../ledger-projection';
import { resolveContextLedgerSelection } from '../ledger-selection';

const labels = {
  systemPrompt: 'System prompt',
  assistant: 'Assistant',
  toolResult: 'Tool result',
  contextSummary: 'Context summary',
  user: 'User',
  emptyContent: 'Empty',
};

describe('resolveContextLedgerSelection', () => {
  it('keeps manually selected prompts and unchanged messages selected after an append refresh', () => {
    const first = projectContextLedger(snapshot([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ]), 1, labels).rows;
    const refreshed = projectContextLedger(snapshot([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: 'next question' },
    ], true), 2, labels).rows;

    expect(resolveContextLedgerSelection(refreshed, row(first, 'system'))?.key)
      .toBe('2:system');
    expect(resolveContextLedgerSelection(refreshed, toolRow(first, 'browser-core_hoverByUid'))?.key)
      .toBe('2:tool:1:browser-core_hoverByUid');
    expect(resolveContextLedgerSelection(refreshed, messageRow(first, 1))?.key)
      .toBe('2:message:1');
  });

  it('does not bind a selection to a different message occupying the same index', () => {
    const first = projectContextLedger(snapshot([
      { role: 'user', content: 'original message' },
    ]), 1, labels).rows;
    const compacted = projectContextLedger(snapshot([
      { role: 'user', subtype: 'context_summary', content: 'replacement summary' },
    ]), 2, labels).rows;

    expect(resolveContextLedgerSelection(compacted, messageRow(first, 0))).toBeNull();
  });
});

function snapshot(
  messages: ContextSnapshot['messages'],
  reverseTools = false,
): ContextSnapshot {
  const tools = [
    {
      name: 'browser-core_hoverByUid',
      description: 'Hover an element',
      input_schema: {
        type: 'object' as const,
        properties: { uid: { type: 'string' } },
        required: ['uid'],
      },
    },
    {
      name: 'read',
      description: 'Read a file',
      input_schema: {
        type: 'object' as const,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ];
  return {
    systemPrompt: reverseTools ? 'updated system prompt' : 'system prompt',
    tools: reverseTools ? [...tools].reverse() : tools,
    messages,
    requestTokenCheckpoints: [],
    usage: { tokens: 10, limit: 100, percentage: 10 },
  };
}

function row(rows: readonly ContextLedgerRow[], kind: ContextLedgerRow['kind']): ContextLedgerRow {
  const match = rows.find((candidate) => candidate.kind === kind);
  if (!match) throw new Error(`Missing ${kind} row`);
  return match;
}

function toolRow(rows: readonly ContextLedgerRow[], name: string): ContextLedgerRow {
  const match = rows.find((candidate) => candidate.kind === 'tool' && candidate.tool.name === name);
  if (!match) throw new Error(`Missing tool row ${name}`);
  return match;
}

function messageRow(rows: readonly ContextLedgerRow[], messageIndex: number): ContextLedgerRow {
  const match = rows.find((candidate) => (
    candidate.kind === 'message' && candidate.messageIndex === messageIndex
  ));
  if (!match) throw new Error(`Missing message row ${messageIndex}`);
  return match;
}
