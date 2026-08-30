import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/content-links', () => ({
  LinkedText: ({ children }: { children: string }) => createElement('span', null, children),
  LinkedMarkdown: ({ children }: { children: string }) => createElement('div', null, children),
}));
vi.mock('@/utils/platform', () => ({ isMacOSPlatform: () => false }));

import type { MsgEntry } from '../../../../../shared/types/agent-control';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import '@/i18n';
import { ThreadCell } from '../ThreadCell';

describe('subagent failure notice renderer', () => {
  it('renders the provider body and context-window guidance in the conversation', () => {
    const providerMessage = 'Your input exceeds the context window of this model.\n'
      + 'Please adjust your input and try again.';
    const entry: MsgEntry = {
      t: 'msg',
      ts: 1,
      id: 'failure-1',
      role: 'user',
      subtype: 'subagent_notification',
      content: `<subagent_event id="worker-1" type="failed" ts="t" error_type="context_overflow">\n${providerMessage}\n</subagent_event>`,
    };
    const [cell] = projectConversationNodes([entry]);
    if (!cell) throw new Error('Expected one notice cell');

    const html = renderToStaticMarkup(createElement(ThreadCell, { cell }));

    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('子流程失败');
    expect(html).toContain('Your input exceeds the context window of this model.');
    expect(html).not.toContain('limits.contextWindow');
  });
});
