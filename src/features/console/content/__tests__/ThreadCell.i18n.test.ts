import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolNode } from '@/domains/transcript/nodes';
import '@/i18n';
import { messageText, rawText } from '../../data/presentationText';

vi.mock('@/components/content-links', () => ({
  LinkedMarkdown: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  LinkedText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('@/utils/platform', () => ({ isMacOSPlatform: () => false }));

let ThreadCell: typeof import('../ThreadCell').ThreadCell;
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://piskie.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('SVGElement', dom.window.SVGElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ({ ThreadCell } = await import('../ThreadCell'));
});

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('ThreadCell locale presentation', () => {
  it('translates the same projected node without rebuilding its semantic title', async () => {
    const titleArgs = { function: 'example.search' } as const;
    const node: ToolNode = {
      kind: 'tool',
      id: 'tool-1',
      ts: 1,
      sourceIndex: 0,
      tool: 'skill_call',
      titleKey: 'transcript.tool.skillFunction',
      titleArgs,
      summary: messageText('transcript.summary.running'),
      tone: 'neutral',
      interaction: 'none',
      defaultExpanded: false,
      summaryDuplicatesDetail: false,
      actions: [],
      state: { phase: 'ok' },
    };
    const nodes = [node] as const;
    const originalNodes = nodes;
    const originalNode = node;

    await act(async () => {
      root.render(createElement(ThreadCell, { cell: node }));
    });
    expect(container.textContent).toContain('技能调用 example.search · 执行中');

    await act(async () => {
      await i18n.changeLanguage('en-US');
    });

    expect(container.textContent).toContain('Skill call example.search · Running');
    expect(nodes).toBe(originalNodes);
    expect(nodes[0]).toBe(originalNode);
    expect(node.titleKey).toBe('transcript.tool.skillFunction');
    expect(node.titleArgs).toBe(titleArgs);

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    expect(container.textContent).toContain('技能调用 example.search · 执行中');
  });

  it('does not translate raw tool output when the locale changes', async () => {
    const node: ToolNode = {
      kind: 'tool',
      id: 'tool-raw',
      ts: 1,
      sourceIndex: 0,
      tool: 'unknown_tool',
      titleKey: 'transcript.tool.generic',
      titleArgs: { tool: 'unknown_tool' },
      summary: rawText('Successfully navigated to https://example.test/'),
      tone: 'neutral',
      interaction: 'none',
      defaultExpanded: false,
      summaryDuplicatesDetail: false,
      actions: [],
      state: { phase: 'ok' },
    };

    await act(async () => {
      root.render(createElement(ThreadCell, { cell: node }));
    });
    const original = container.textContent;

    await act(async () => {
      await i18n.changeLanguage('en-US');
    });

    expect(container.textContent).toBe(original);
    expect(container.textContent).toContain('Successfully navigated to https://example.test/');
  });

  it('materializes detail only for the lifetime of an expanded row', async () => {
    const materialize = vi.fn(() => ({
      sections: [{ value: 'detail-only fact', format: 'text' as const }],
    }));
    const node: ToolNode = {
      kind: 'tool',
      id: 'tool-detail',
      ts: 1,
      sourceIndex: 0,
      tool: 'read',
      titleKey: 'transcript.tool.readFile',
      tone: 'neutral',
      interaction: 'expand',
      defaultExpanded: false,
      summaryDuplicatesDetail: false,
      actions: [],
      state: { phase: 'ok' },
      detail: materialize,
    };

    await act(async () => {
      root.render(createElement(ThreadCell, { cell: node }));
    });
    expect(materialize).not.toHaveBeenCalled();

    const toggle = container.querySelector('button');
    if (!toggle) throw new Error('tool row toggle missing');
    await act(async () => toggle.click());
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('detail-only fact');

    await act(async () => toggle.click());
    expect(container.textContent).not.toContain('detail-only fact');

    await act(async () => toggle.click());
    expect(materialize).toHaveBeenCalledTimes(2);
  });
});
