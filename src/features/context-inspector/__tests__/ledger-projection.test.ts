import { describe, expect, it } from 'vitest';
import type { ContextSnapshot } from '@shared/types/token';
import { projectContextLedger } from '../ledger-projection';

const labels = {
  systemPrompt: '系统提示词',
  assistant: '助手',
  toolResult: '工具结果',
  contextSummary: '上下文摘要',
  user: '用户',
  emptyContent: '空内容',
};

describe('projectContextLedger', () => {
  it('preserves structured facts and excludes opaque payloads from readable search text', () => {
    const snapshot: ContextSnapshot = {
      systemPrompt: 'system',
      tools: [{
        name: 'read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private thought', signature: 'secret-signature' },
          { type: 'tool_use', id: 'call-1', name: 'read', input: { path: '/tmp/a' } },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'very-secret-base64' },
          },
        ],
      }],
      requestTokenCheckpoints: [{ messageIndex: 0, inputTokens: 10 }],
      usage: { tokens: 10, limit: 100, percentage: 10 },
    };

    const projection = projectContextLedger(snapshot, 7, labels);
    const message = projection.rows.find((row) => row.kind === 'message');
    expect(message?.key).toBe('7:message:0');
    expect(message?.searchText).toContain('private thought');
    expect(message?.searchText).toContain('call-1');
    expect(message?.searchText).toContain('image/png');
    expect(message?.searchText).not.toContain('secret-signature');
    expect(message?.searchText).not.toContain('very-secret-base64');
    expect((message as { message: unknown }).message).toBe(snapshot.messages[0]);
    expect(message?.inputTokens).toBe(10);

    const system = projection.rows.find((row) => row.kind === 'system');
    const tool = projection.rows.find((row) => row.kind === 'tool');
    expect(projection.counts).toEqual({ system: 1, tool: 1, message: 1 });
    expect(system?.subtitle).toBe('system');
    expect(tool?.subtitle).toContain('"type": "object"');
    expect(tool?.subtitle).not.toContain('Tool definition');
    expect(message?.subtitle).toContain('private thought');
  });

  it('keeps the first request total and derives later deltas from adjacent provider totals', () => {
    const snapshot: ContextSnapshot = {
      systemPrompt: 'system',
      tools: [],
      messages: [
        { role: 'assistant', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'assistant', content: 'after compaction' },
      ],
      requestTokenCheckpoints: [
        { messageIndex: 0, inputTokens: 20_890 },
        { messageIndex: 1, inputTokens: 21_029 },
        { messageIndex: 2, inputTokens: 18_000 },
      ],
      usage: { tokens: 18_000, limit: 100_000, percentage: 18 },
    };

    const messages = projectContextLedger(snapshot, 1, labels).rows.filter(
      (row) => row.kind === 'message',
    );
    expect(messages.map((row) => ({
      inputTokens: row.inputTokens,
      inputTokenDelta: row.inputTokenDelta,
    }))).toEqual([
      { inputTokens: 20_890, inputTokenDelta: undefined },
      { inputTokens: 21_029, inputTokenDelta: 139 },
      { inputTokens: 18_000, inputTokenDelta: -3_029 },
    ]);
  });
});
