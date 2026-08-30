import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { Transcript } from '../Transcript';

describe('AgentActivityRow', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
  });

  it('replaces the empty state and reprojects elapsed time when the locale changes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(338_000);
    const render = () => renderToStaticMarkup(createElement(Transcript, {
        nodes: [],
        renderNode: () => null,
        emptyText: '暂无日志',
        activeStartedAt: 0,
      }));

    await i18n.changeLanguage('zh-CN');
    const chinese = render();
    expect(chinese).toContain('Working…');
    expect(chinese).toContain('5分38秒');
    expect(chinese).toContain('data-orb-variant="orbit"');
    expect(chinese).not.toContain('暂无日志');

    await i18n.changeLanguage('en-US');
    const english = render();
    expect(english).toContain('Working…');
    expect(english).toContain('5m 38s');

    await i18n.changeLanguage('zh-CN');
    expect(render()).toContain('Working…');
  });
});
