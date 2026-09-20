import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { textareaVisualLine } from '../textareaVisualLine';

const VALUE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz';
const LINE_STARTS = [0, 13, 26, 39, 52, 65, 78];

function rect(top: number): DOMRect {
  return {
    x: 0, y: top, top, right: 0, bottom: top + 20, left: 0,
    width: 0, height: 20, toJSON: () => ({}),
  };
}

function lineOf(position: number): number {
  return LINE_STARTS.findLastIndex((start) => start <= position);
}

describe('textareaVisualLine', () => {
  let dom: JSDOM;
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><textarea></textarea></body></html>');
    textarea = dom.window.document.querySelector('textarea')!;
    textarea.value = VALUE;
    textarea.style.cssText = [
      'box-sizing: border-box', 'width: 140px', 'padding: 4px',
      'font: 16px/20px "Courier New", monospace', 'white-space: pre-wrap',
      'overflow-wrap: break-word',
    ].join(';');
    Object.defineProperty(textarea, 'clientWidth', { configurable: true, value: 138 });

    vi.spyOn(dom.window.document, 'createRange').mockImplementation(() => {
      let position = 0;
      const range = {
        setStart: (_node: Node, offset: number) => { position = offset - 1; },
        collapse: () => undefined,
        getClientRects: () => {
          const line = lineOf(position);
          const tops = LINE_STARTS.includes(position) && position > 0
            ? [(line - 1) * 20, line * 20]
            : [line * 20];
          return {
            length: tops.length,
            item: (index: number) => tops[index] === undefined ? null : rect(tops[index]),
          } as DOMRectList;
        },
        getBoundingClientRect: () => rect(lineOf(position) * 20),
      };
      return range as unknown as Range;
    });
  });

  afterEach(() => {
    dom.window.close();
    vi.restoreAllMocks();
  });

  it('classifies every caret position across soft-wrapped visual lines', () => {
    for (let position = 0; position <= VALUE.length; position += 1) {
      textarea.setSelectionRange(position, position);
      expect(textareaVisualLine(textarea), `caret ${position}`).toEqual({
        first: position <= 12,
        last: position >= 78,
      });
    }
  });

  it('uses the downstream rectangle at exact soft-wrap boundaries', () => {
    for (const [position, expected] of [
      [12, { first: true, last: false }],
      [13, { first: false, last: false }],
      [77, { first: false, last: false }],
      [78, { first: false, last: true }],
    ] as const) {
      textarea.setSelectionRange(position, position);
      expect(textareaVisualLine(textarea)).toEqual(expected);
    }
  });

  it('falls back to explicit line breaks when layout is unavailable', () => {
    Object.defineProperty(textarea, 'clientWidth', { configurable: true, value: 0 });
    textarea.value = 'First line\nSecond line';

    textarea.setSelectionRange(3, 3);
    expect(textareaVisualLine(textarea)).toEqual({ first: true, last: false });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    expect(textareaVisualLine(textarea)).toEqual({ first: false, last: true });
  });
});
