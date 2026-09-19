const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'Event',
    'KeyboardEvent',
  ] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? dom.window : dom.window[name],
    });
  }
  return dom;
});

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GateFeedback, type GateFeedbackProps } from '../parts';

let root: Root;
let container: HTMLDivElement;
let onChange: ReturnType<typeof vi.fn<(value: string) => void>>;
let onSubmit: ReturnType<typeof vi.fn<() => void>>;
let onPaste: ReturnType<typeof vi.fn<React.ClipboardEventHandler>>;
let onDragOver: ReturnType<typeof vi.fn<React.DragEventHandler>>;
let onDrop: ReturnType<typeof vi.fn<React.DragEventHandler>>;

function render(overrides: Partial<GateFeedbackProps> = {}): void {
  const props: GateFeedbackProps = {
    ordinal: 2,
    value: 'Sample response',
    onChange,
    onSubmit,
    onPaste,
    onDragOver,
    onDrop,
    placeholder: 'Enter a sample response',
    canSubmit: true,
    ...overrides,
  };
  act(() => root.render(React.createElement(GateFeedback, props)));
}

function press(element: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => element.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onChange = vi.fn();
  onSubmit = vi.fn();
  onPaste = vi.fn();
  onDragOver = vi.fn();
  onDrop = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

afterAll(() => testDOM.window.close());

describe('GateFeedback', () => {
  it('renders the multiline opt-in as a one-row textarea and preserves field handlers', () => {
    render({ multiline: true });

    const textarea = container.querySelector('textarea')!;
    expect(container.querySelector('input')).toBeNull();
    expect(textarea.rows).toBe(1);
    expect(textarea.value).toBe('Sample response');
    expect(textarea.placeholder).toBe('Enter a sample response');
    expect(textarea.parentElement?.dataset.multiline).toBe('true');
    expect(container.querySelector('kbd')?.textContent).toBe('2');

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Sample line one\nSample line two');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('paste', { bubbles: true }));
      textarea.dispatchEvent(new Event('dragover', { bubbles: true }));
      textarea.dispatchEvent(new Event('drop', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith('Sample line one\nSample line two');
    expect(onPaste).toHaveBeenCalledOnce();
    expect(onDragOver).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledOnce();

    const send = container.querySelector<HTMLButtonElement>('button')!;
    expect(send.getAttribute('aria-label')).toBeTruthy();
    act(() => send.click());
    expect(onSubmit).toHaveBeenCalledOnce();

    render({ multiline: true, disabled: true, canSubmit: false });
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    expect(container.querySelector('button')?.disabled).toBe(true);
  });

  it('submits on Enter, leaves Shift+Enter for a newline, and ignores composition Enter', () => {
    render({ multiline: true });
    const textarea = container.querySelector('textarea')!;

    const enter = press(textarea, { key: 'Enter' });
    expect(enter.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledOnce();

    const shifted = press(textarea, { key: 'Enter', shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    expect(onSubmit).toHaveBeenCalledOnce();

    const composing = press(textarea, { key: 'Enter', isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('keeps the default single-line input and its Enter submission behavior', () => {
    render();

    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(input.parentElement?.dataset.multiline).toBeUndefined();

    const enter = press(input, { key: 'Enter' });
    expect(enter.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledOnce();

    const shifted = press(input, { key: 'Enter', shiftKey: true });
    expect(shifted.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
