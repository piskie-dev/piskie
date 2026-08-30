import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextSnapshot } from '@shared/types/token';
import '@/i18n';
import { ContextLedger } from '../ContextLedger';
import { ContextTimeline } from '../ContextTimeline';
import { contextTimelineFocusKeys } from '../context-timeline';
import { projectContextLedger } from '../ledger-projection';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
const scrollTo = vi.fn();

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
  vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 90,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });
});

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  scrollTo.mockClear();
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

const snapshot: ContextSnapshot = {
  systemPrompt: 'system prompt',
  tools: [{
    name: 'read',
    description: 'Read a file',
    input_schema: { type: 'object', properties: {} },
  }],
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }],
    },
  ],
  requestTokenCheckpoints: [{ messageIndex: 1, inputTokens: 20 }],
  usage: { tokens: 20, limit: 100, percentage: 20 },
};
const projectionLabels = {
  systemPrompt: '系统提示词',
  assistant: '助手',
  toolResult: '工具结果',
  contextSummary: '上下文摘要',
  user: '用户',
  emptyContent: '空内容',
};
const rows = projectContextLedger(snapshot, 1, projectionLabels).rows;

describe('ContextTimeline', () => {
  it('keeps the full context sequence in three lanes while marking matches and selection', async () => {
    await act(async () => {
      root.render(createElement(ContextTimeline, {
        rows,
        range: null,
        selectedKey: rows[2]?.key ?? null,
        matchKeys: new Set([rows[2]?.key ?? '']),
        onRangeChange: vi.fn(),
        onSelect: vi.fn(),
      }));
    });

    expect(container.querySelector('[aria-label="上下文时间轴"]')).not.toBeNull();
    expect(container.textContent).toContain('输入模型工具');
    const spans = [...container.querySelectorAll<HTMLElement>('[data-context-timeline-record-index]')];
    expect(spans).toHaveLength(rows.length);
    expect(spans.map((span) => span.dataset.kind)).toEqual([
      'system', 'tool', 'user', 'assistant', 'result',
    ]);
    expect(spans[2]?.dataset.current).toBe('true');
    expect(spans[0]?.dataset.searchMatch).toBe('false');
    expect(spans[2]?.dataset.searchMatch).toBe('true');
  });

  it('labels the first checkpoint with its total and later checkpoints with deltas', async () => {
    const deltaRows = projectContextLedger({
      systemPrompt: 'system',
      tools: [],
      messages: [
        { role: 'assistant', content: 'first' },
        { role: 'assistant', content: 'second' },
      ],
      requestTokenCheckpoints: [
        { messageIndex: 0, inputTokens: 20_890 },
        { messageIndex: 1, inputTokens: 21_029 },
      ],
      usage: { tokens: 21_029, limit: 100_000, percentage: 21.029 },
    }, 2, projectionLabels).rows;

    await act(async () => {
      root.render(createElement(ContextTimeline, {
        rows: deltaRows,
        range: null,
        selectedKey: null,
        onRangeChange: vi.fn(),
        onSelect: vi.fn(),
      }));
    });

    const titles = [...container.querySelectorAll<HTMLElement>(
      '[data-context-timeline-record-index]',
    )].map((span) => span.title);
    expect(titles).toContain('001 · 助手 · 助手 · 20,890 tokens');
    expect(titles).toContain('002 · 助手 · 助手 · +139 tokens');
  });

  it('selects a clicked record and commits a horizontally dragged focus range', async () => {
    const onRangeChange = vi.fn();
    const onSelect = vi.fn();
    await act(async () => {
      root.render(createElement(ContextTimeline, {
        rows,
        range: null,
        selectedKey: rows[0]?.key ?? null,
        onRangeChange,
        onSelect,
      }));
    });

    const track = container.querySelector<HTMLElement>('[data-context-timeline-track]');
    const target = container.querySelector<HTMLElement>('[data-context-timeline-record-index="2"]');
    if (!track || !target) throw new Error('Timeline did not render');
    track.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 500,
      bottom: 50,
      left: 0,
      width: 500,
      height: 50,
      toJSON: () => ({}),
    });

    await act(async () => {
      dispatchPointer(target, 'pointerdown', 250);
      dispatchPointer(target, 'pointerup', 250);
    });
    expect(onRangeChange).toHaveBeenLastCalledWith(null);
    expect(onSelect).toHaveBeenLastCalledWith(rows[2]);

    onRangeChange.mockClear();
    onSelect.mockClear();
    await act(async () => {
      dispatchPointer(track, 'pointerdown', 100);
      dispatchPointer(track, 'pointermove', 400);
      dispatchPointer(track, 'pointerup', 400);
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onRangeChange).toHaveBeenLastCalledWith({ start: 1, end: 4 });
  });

  it('projects a dragged range to the intersecting ledger rows', () => {
    const keys = contextTimelineFocusKeys(rows, { start: 1.25, end: 4.1 });
    expect([...keys ?? []]).toEqual(rows.slice(1, 5).map((row) => row.key));
  });
});

describe('ContextLedger timeline navigation', () => {
  it('scrolls virtualized rows for direct selection and timeline focus', async () => {
    await act(async () => {
      root.render(createElement(ContextLedger, {
        rows,
        selectedKey: rows[4]?.key ?? null,
        onSelect: vi.fn(),
      }));
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 90, behavior: 'smooth' });

    scrollTo.mockClear();
    await act(async () => {
      root.render(createElement(ContextLedger, {
        rows,
        selectedKey: null,
        timelineFocusKeys: new Set([rows[3]?.key ?? '', rows[4]?.key ?? '']),
        onSelect: vi.fn(),
      }));
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 60, behavior: 'smooth' });
    expect(container.querySelectorAll('[data-timeline-focus="outside"]')).toHaveLength(3);
  });
});

function dispatchPointer(target: HTMLElement, type: string, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(event, 'pointerId', { value: 7 });
  target.dispatchEvent(event);
}
