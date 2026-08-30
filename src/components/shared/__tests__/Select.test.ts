import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Select } from '../Select';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('Select', () => {
  it('renders option labels and hints as plain text without changing selection behavior', async () => {
    const onChange = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await act(async () => {
      root.render(createElement(Select, {
        value: 'gpt-image-2',
        options: [
          { value: 'sdxl-lightning-4step', label: 'sdxl-lightning-4step', hint: 'Legacy ComfyUI' },
          { value: 'gpt-image-2', label: 'gpt-image-2', hint: 'OpenAI 2' },
          { value: 'disabled', label: '不可用模型', disabled: true },
        ],
        onChange,
        ariaLabel: '生图模型',
      }));
    });

    const select = container.querySelector('select');
    const options = Array.from(container.querySelectorAll('option'));
    expect(select?.getAttribute('aria-label')).toBe('生图模型');
    expect(container.querySelector('select > button')?.textContent).toBe('gpt-image-2');
    expect(options.map((option) => option.textContent)).toEqual([
      'sdxl-lightning-4step · Legacy ComfyUI',
      'gpt-image-2 · OpenAI 2',
      '不可用模型',
    ]);
    expect(options.every((option) => option.children.length === 0)).toBe(true);
    expect(options[2]?.disabled).toBe(true);
    expect(consoleError.mock.calls.flat().join('\n')).not.toContain('<span>\noption');

    await act(async () => {
      if (!select) throw new Error('Select was not rendered');
      select.value = 'sdxl-lightning-4step';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('sdxl-lightning-4step');
  });
});
