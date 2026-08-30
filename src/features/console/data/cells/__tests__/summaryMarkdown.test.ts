import { describe, expect, it } from 'vitest';

import type { SummaryEntry } from '../../../../../../shared/types/agent-control';
import { projectConversationNodes } from '@/domains/transcript/project-entry';

describe('summary cell Markdown projection', () => {
  it('passes the AI summary string directly to the existing Markdown renderer', () => {
    const markdown = [
      '# Compact summary',
      '',
      '## Summary',
      '',
      '- 已完成两个目标',
      '- **CURRENT TASK**: 完成第三个目标',
    ].join('\n');
    const entry: SummaryEntry = {
      t: 'summary',
      ts: 1,
      summary: {
        id: 'summary-1',
        markdown,
        compressedCount: 10,
        originalTokens: 80_000,
        createdAt: 1,
      },
    };

    const [cell] = projectConversationNodes([entry]);

    expect(cell).toMatchObject({
      kind: 'summary',
      compactionId: 'summary-1',
    });
    expect(cell?.kind === 'summary' && cell.preview).toContain('Compact summary');
    expect(cell?.detail?.().sections).toEqual([{
      value: markdown,
      format: 'markdown',
    }]);
  });
});
