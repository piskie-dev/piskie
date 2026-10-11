import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { Transcript } from '../Transcript';
import { AgentActivityRow } from '../AgentActivityRow';

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
    expect(chinese).toContain('data-orb-variant="expanding"');
    expect(chinese).not.toContain('暂无日志');

    await i18n.changeLanguage('en-US');
    const english = render();
    expect(english).toContain('Working…');
    expect(english).toContain('5m 38s');

    await i18n.changeLanguage('zh-CN');
    expect(render()).toContain('Working…');
  });

  it.each(['en-US', 'zh-CN'])('shows the receiving arrow for both output counts in %s and preserves accessible labels', async (locale) => {
    await i18n.changeLanguage(locale);
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const render = (estimated: boolean) => renderToStaticMarkup(createElement(Transcript, {
      nodes: [], renderNode: () => null, activeStartedAt: 0,
      activeOutputTokens: { count: 1_234, estimated },
    }));
    const estimated = render(true);
    expect(estimated).toContain('↓1.2k tokens');
    expect(estimated).not.toContain('≈');
    expect(estimated).toContain(locale === 'en-US' ? 'Approximately 1,234 output tokens' : '估算约 1,234 个输出 token');
    const exact = render(false);
    expect(exact).toContain('↓1.2k tokens');
    expect(exact).not.toContain('≈');
    expect(exact).toContain(locale === 'en-US' ? '1,234 output tokens reported by providers' : 'Provider 已报告 1,234 个输出 token');
  });

  it('hides output with the finished activity and leaves a new activity without an old count', () => {
    const ended = renderToStaticMarkup(createElement(Transcript, {
      nodes: [], renderNode: () => null, activeOutputTokens: { count: 999, estimated: false },
    }));
    expect(ended).not.toContain('999 tokens');
    expect(ended).not.toContain('Working…');
    const fresh = renderToStaticMarkup(createElement(Transcript, {
      nodes: [], renderNode: () => null, activeStartedAt: 1_000,
    }));
    expect(fresh).toContain('Working…');
    expect(fresh).not.toContain('tokens');
  });

  it('updates elapsed time without increasing tokens and reacts to a real count correction', async () => {
    await i18n.changeLanguage('en-US');
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    dom.window.Element.prototype.getAnimations = () => [];
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(AgentActivityRow, {
        activeStartedAt: 0, activeOutputTokens: { count: 7, estimated: true },
      })));
      expect(container.textContent).toContain('1s');
      expect(container.textContent).toContain('↓7 tokens');
      await act(async () => { vi.advanceTimersByTime(5_000); });
      expect(container.textContent).toContain('6s');
      expect(container.textContent).toContain('↓7 tokens');
      await act(async () => root.render(createElement(AgentActivityRow, {
        activeStartedAt: 0, activeOutputTokens: { count: 9, estimated: false },
      })));
      expect(container.textContent).toContain('↓9 tokens');
      expect(container.textContent).not.toContain('≈');
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });
});
