import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoticeNode, ToolNode, UserNode } from '@/domains/transcript/nodes';
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
  it('renders parent and child flow messages with the same disclosure structure', async () => {
    const parentNode: UserNode = {
      kind: 'user',
      id: 'parent-message-1',
      ts: 1,
      sourceIndex: 0,
      origin: 'parent',
      titleKey: 'transcript.title.parentEvent',
      summary: rawText('继续检查构建结果'),
      text: '请继续检查完整构建结果。',
      tone: 'neutral',
      interaction: 'expand',
      defaultExpanded: false,
      summaryDuplicatesDetail: false,
      detail: () => ({ sections: [{ value: '请继续检查完整构建结果。', format: 'text' }] }),
    };
    const childNode: NoticeNode = {
      kind: 'notice',
      id: 'child-message-1',
      ts: 2,
      sourceIndex: 1,
      source: 'worker-1',
      text: '构建检查已经完成。',
      eventType: 'message',
      titleKey: 'transcript.notice.workerMessage',
      summary: rawText('构建检查已经完成'),
      tone: 'neutral',
      interaction: 'expand',
      defaultExpanded: false,
      summaryDuplicatesDetail: false,
      detail: () => ({ sections: [{ value: '构建检查已经完成。', format: 'text' }] }),
    };

    await act(async () => {
      root.render(createElement(
        'div',
        null,
        createElement(ThreadCell, { cell: parentNode }),
        createElement(ThreadCell, { cell: childNode }),
      ));
    });

    const flowEvents = [...container.querySelectorAll<HTMLElement>('[data-flow-event]')];
    expect(flowEvents).toHaveLength(2);
    const toggles = flowEvents.map((event) => event.querySelector<HTMLButtonElement>('button'));
    expect(toggles.every(Boolean)).toBe(true);
    expect(toggles[0]?.className).toBe(toggles[1]?.className);
    expect(flowEvents[0]?.dataset.eventType).toBe('message');
    expect(flowEvents[1]?.dataset.eventType).toBe('message');
    expect(container.textContent).toContain('收到主流程消息');
    expect(container.textContent).toContain('收到子流程消息');

    await act(async () => toggles[0]?.click());
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(flowEvents[0]?.textContent).toContain('请继续检查完整构建结果。');
  });

  it('renders completed flow events with their success state and icon', async () => {
    const completedNode: NoticeNode = {
      kind: 'notice',
      id: 'child-completed-1',
      ts: 1,
      sourceIndex: 0,
      source: 'worker-1',
      text: '构建检查已经完成。',
      eventType: 'completed',
      titleKey: 'transcript.notice.workerCompleted',
      summary: rawText('构建检查已经完成'),
      tone: 'neutral',
      interaction: 'expand',
      defaultExpanded: false,
      summaryDuplicatesDetail: false,
      detail: () => ({ sections: [{ value: '构建检查已经完成。', format: 'text' }] }),
    };

    await act(async () => {
      root.render(createElement(ThreadCell, { cell: completedNode }));
    });

    const flowEvent = container.querySelector<HTMLElement>('[data-flow-event]');
    expect(flowEvent?.dataset.eventType).toBe('completed');
    expect(flowEvent?.querySelector('svg')?.classList.contains('lucide-circle-check')).toBe(true);
    expect(container.textContent).toContain('子流程完成');
  });

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
