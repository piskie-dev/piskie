import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PendingAgentEventView } from '../../../../../../shared/types/agent-control';
import { PendingEventQueue } from '../PendingEventQueue';

const sources: ReadonlyArray<PendingAgentEventView['source']> = [
  'user',
  'api',
  'webhook',
  'system',
  'browser',
  'module',
  'parent',
  'subagent',
];

describe('PendingEventQueue', () => {
  it('renders every queued source and content with stable event ids', () => {
    const events = sources.map((source, index): PendingAgentEventView => ({
      id: `event-${source}`,
      timestamp: index,
      source,
      content: source === 'system' ? { type: 'refresh', sequence: index } : `content-${source}`,
      priority: source === 'api' ? 'high' : undefined,
      imageCount: source === 'user' ? 2 : 0,
    }));

    const markup = renderToStaticMarkup(createElement(PendingEventQueue, { events }));

    expect(markup).toContain('待处理消息（8）');
    for (const source of sources) {
      expect(markup).toContain(`data-event-id="event-${source}"`);
      expect(markup).toContain(`data-source="${source}"`);
    }
    expect(markup).toContain('content-user');
    expect(markup).toContain('refresh');
    expect(markup).toContain('sequence');
    expect(markup).toContain('高优先级');
    expect(markup).toContain('2 张图片');
  });

  it('renders nothing when the Mailbox snapshot is empty', () => {
    expect(renderToStaticMarkup(createElement(PendingEventQueue, { events: [] }))).toBe('');
  });
});
