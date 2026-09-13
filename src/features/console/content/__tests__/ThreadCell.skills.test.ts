import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '../../../../../shared/types';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import { ThreadCell } from '../ThreadCell';

vi.mock('@/utils/platform', () => ({ isMacOSPlatform: () => false }));
vi.mock('@/components/content-links', () => ({
  LinkedMarkdown: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  LinkedText: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../StreamingMarkdown', () => ({ StreamingMarkdown: () => null }));

function history(entries: ConversationEntry[]) {
  // Rehydration uses the persisted message metadata, without looking up today's skills.
  const restored = JSON.parse(JSON.stringify(entries)) as ConversationEntry[];
  const nodes = projectConversationNodes(restored);
  return new JSDOM(renderToStaticMarkup(createElement('main', null,
    nodes.map((cell) => createElement(ThreadCell, { key: cell.id, cell })),
  )));
}

describe('message skill history', () => {
  it.each(['system_task', 'user_input'] as const)('restores %s tags and per-skill failures with their original message', (subtype) => {
    const dom = history([{
      t: 'msg', id: 'sample-selected', ts: 1, role: 'user', subtype,
      content: 'Example task',
      metadata: {
        skills: ['sample-guide', 'sample-table'],
        skillLoadErrors: [{ name: 'sample-table', error: 'Example resource unavailable' }],
      },
    }, {
      t: 'msg', id: 'sample-next', ts: 2, role: 'user', subtype: 'user_input', content: 'Next example',
    }]);
    const bubbles = dom.window.document.querySelectorAll<HTMLElement>('[class*="bubble"]');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]!.textContent).toContain('sample-guidesample-table');
    expect(bubbles[0]!.textContent).toContain('Example task');
    expect(bubbles[0]!.textContent).toContain('技能 sample-table 加载失败：Example resource unavailable');
    expect(bubbles[1]!.textContent).toBe('Next example');
    expect(bubbles[1]!.querySelector('[aria-label="已选技能"]')).toBeNull();
    expect(dom.window.document.querySelector('button')).toBeNull();
    dom.window.close();
  });

  it('renders skill-only tasks and complete failure feedback, while old slash text remains ordinary text', () => {
    const dom = history([{
      t: 'msg', id: 'sample-only', ts: 1, role: 'user', subtype: 'user_input', content: '',
      metadata: { skills: ['sample-guide'], skillLoadErrors: [{ name: 'sample-guide', error: 'Example skill disabled' }] },
    }, {
      t: 'msg', id: 'sample-plain', ts: 2, role: 'user', subtype: 'system_task', content: '/sample-guide',
    }]);
    const bubbles = dom.window.document.querySelectorAll<HTMLElement>('[class*="bubble"]');
    expect(bubbles[0]!.querySelector('[aria-label="已选技能"]')?.textContent).toBe('sample-guide');
    expect(bubbles[0]!.textContent).toContain('Example skill disabled');
    expect(bubbles[1]!.textContent).toBe('/sample-guide');
    expect(bubbles[1]!.querySelector('[aria-label="已选技能"]')).toBeNull();
    dom.window.close();
  });
});
