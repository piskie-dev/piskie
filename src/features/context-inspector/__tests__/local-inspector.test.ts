import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/content-links', () => ({
  LinkedMarkdown: ({ children }: { readonly children: string }) => children,
}));

import { LocalInspector } from '../LocalInspector';
import type { ContextLedgerRow } from '../ledger-projection';

describe('LocalInspector', () => {
  it('shows the complete tool definition without a separate description panel', () => {
    const row: ContextLedgerRow = {
      kind: 'tool',
      key: '1:tool:0:read',
      title: 'read',
      subtitle: '{ "type": "object" }',
      searchText: 'read\nRead a file',
      toolIndex: 0,
      tool: {
        name: 'read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    };

    const markup = renderToStaticMarkup(createElement(LocalInspector, {
      row,
      agentId: 'agent-1',
    }));

    expect(markup).toContain('&quot;description&quot;: &quot;Read a file&quot;');
    expect(markup).toContain('&quot;input_schema&quot;');
    expect(markup).toContain('工具 #1');
    expect(markup).not.toMatch(/>\s*DESCRIPTION\s*</);
  });

  it('shows a provider-measured request token checkpoint on its assistant response', () => {
    const row: ContextLedgerRow = {
      kind: 'message',
      key: '1:message:2',
      title: '助手',
      subtitle: 'answer',
      searchText: 'answer',
      messageIndex: 2,
      inputTokens: 12_345,
      message: { role: 'assistant', content: 'answer' },
    };

    const markup = renderToStaticMarkup(createElement(LocalInspector, {
      row,
      agentId: 'agent-1',
    }));

    expect(markup).toContain('助手消息 #3 · 12,345 tokens');
  });

  it('shows the delta after the first provider-measured checkpoint', () => {
    const row: ContextLedgerRow = {
      kind: 'message',
      key: '1:message:4',
      title: '助手',
      subtitle: 'next answer',
      searchText: 'next answer',
      messageIndex: 4,
      inputTokens: 12_690,
      inputTokenDelta: 345,
      message: { role: 'assistant', content: 'next answer' },
    };

    const markup = renderToStaticMarkup(createElement(LocalInspector, {
      row,
      agentId: 'agent-1',
    }));

    expect(markup).toContain('助手消息 #5 · +345 tokens');
    expect(markup).not.toContain('12,690 tokens');
  });
});
