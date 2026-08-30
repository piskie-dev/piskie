import { describe, expect, it } from 'vitest';

import type { ConversationEntry, PersistedMessageBlock } from '../../../../../../shared/types/agent-control';
import { projectConversationNodes } from '@/domains/transcript/project-entry';

function assistant(content: PersistedMessageBlock[]): ConversationEntry {
  return {
    t: 'msg',
    ts: 1,
    id: 'assistant-order',
    role: 'assistant',
    content,
  };
}

describe('canonical reasoning projection', () => {
  it('preserves provider block order, prefers summary, and falls back after blank summaries', () => {
    const entry: ConversationEntry = {
      t: 'msg',
      ts: 1,
      id: 'assistant-1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'before' },
        {
          type: 'openai_reasoning',
          summary: [{ type: 'summary_text', text: '  ' }],
          reasoning_content: [{ type: 'reasoning_text', text: 'fallback reasoning' }],
        },
        { type: 'redacted_thinking', data: 'opaque-redacted' },
        {
          type: 'openai_reasoning',
          summary: [],
          encrypted_content: 'opaque-encrypted',
        },
        { type: 'thinking', thinking: 'anthropic thought', signature: 'signature' },
        {
          type: 'openai_reasoning',
          summary: [{ type: 'summary_text', text: 'public summary' }],
          reasoning_content: [{ type: 'reasoning_text', text: 'private detail' }],
        },
        { type: 'text', text: 'after' },
      ],
    };

    const cells = projectConversationNodes([entry]);

    expect(cells.map((cell) => cell.kind)).toEqual([
      'assistant',
      'think',
      'think',
      'think',
      'assistant',
    ]);
    expect(cells.map((cell) => 'markdown' in cell ? cell.markdown : undefined)).toEqual([
      'before',
      'fallback reasoning',
      'anthropic thought',
      'public summary',
      'after',
    ]);
    expect(JSON.stringify(cells)).not.toContain('opaque-redacted');
    expect(JSON.stringify(cells)).not.toContain('opaque-encrypted');
    expect(JSON.stringify(cells)).not.toContain('private detail');
  });

  it('shows a tool only from the canonical assistant entry and keeps provider block order', () => {
    const tool: PersistedMessageBlock = {
      type: 'tool_use',
      id: 'call-1',
      name: 'read',
      input: { path: '/workspace/file.ts' },
    };

    expect(projectConversationNodes([assistant([tool])]).map((cell) => cell.kind)).toEqual(['tool']);
    expect(projectConversationNodes([assistant([
      { type: 'thinking', thinking: 'inspect first' },
      tool,
    ])]).map((cell) => cell.kind)).toEqual(['think', 'tool']);
    expect(projectConversationNodes([assistant([
      { type: 'text', text: 'I will inspect it.' },
      tool,
    ])]).map((cell) => cell.kind)).toEqual(['assistant', 'tool']);
  });
});
