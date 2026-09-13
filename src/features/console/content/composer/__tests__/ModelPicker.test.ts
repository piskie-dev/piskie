// JSDOM 全局必须先于 react-dom 加载，否则 React 会判定不支持 input 事件而走 polyfill 路径。
const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  return dom;
});

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../ModelPicker';
import type { ModelOptGroup } from '../../../../../store/inferenceStore';

vi.mock('../../../chrome/Popover', () => ({
  Popover: ({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, trigger, children),
}));
const effortProfile = {
  mode: 'effort',
  options: [
    { kind: 'disabled' },
    { kind: 'effort', effort: 'low' },
    { kind: 'effort', effort: 'high' },
  ],
  defaultSelection: { kind: 'effort', effort: 'high' },
  mandatory: false,
};
const budgetProfile = {
  mode: 'budget',
  options: [{ kind: 'budget', tokens: 8192 }],
  defaultSelection: { kind: 'budget', tokens: 8192 },
  mandatory: true,
  minBudgetTokens: 1024,
  maxBudgetTokens: 32768,
};
function groups(defaultReasoning: unknown, profile: unknown = effortProfile): ModelOptGroup[] {
  return [
    {
      label: 'Provider',
      options: [
        {
          value: 'p::model',
          label: 'Model',
          target: { providerId: 'p', modelId: 'model' },
          definition: { id: 'model', reasoning: profile },
          defaultReasoning,
        },
      ],
    },
  ] as ModelOptGroup[];
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
afterAll(() => testDOM.window.close());

describe('ModelPicker actual runtime reasoning', () => {
  it('displays the actual selection without writing on mount or model-default refresh', async () => {
    const change = vi.fn().mockResolvedValue(undefined);
    const render = (defaultReasoning: unknown) =>
      act(async () =>
        root.render(
          React.createElement(ModelPicker, {
            model: 'p::model',
            modelGroups: groups(defaultReasoning),
            reasoningOverride: { kind: 'disabled' },
            onModelChange: vi.fn(),
            onReasoningChange: change,
          })
        )
      );
    await render({ kind: 'effort', effort: 'high' });
    const selected = () => container.querySelector('button[data-selected="true"]');
    // The model row is also selected; inspect the reasoning chip.
    expect(container.querySelector('[class*="chip"][data-selected="true"]')?.textContent).toBe(
      '关闭'
    );
    expect(selected()).not.toBeNull();
    expect(change).not.toHaveBeenCalled();
    await render({ kind: 'effort', effort: 'low' });
    expect(container.querySelector('[class*="chip"][data-selected="true"]')?.textContent).toBe(
      '关闭'
    );
    expect(change).not.toHaveBeenCalled();
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '高')!
        .click();
    });
    expect(change).toHaveBeenCalledExactlyOnceWith({ kind: 'effort', effort: 'high' });
  });

  it('commits a token budget only on blur when it is an integer within the model range', async () => {
    const change = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        React.createElement(ModelPicker, {
          model: 'p::model',
          modelGroups: groups(undefined, budgetProfile),
          reasoningOverride: { kind: 'budget', tokens: 4096 },
          onModelChange: vi.fn(),
          onReasoningChange: change,
        })
      )
    );
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(input.value).toBe('4096');
    const type = (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const blur = () =>
      act(async () => {
        input.dispatchEvent(new Event('focusout', { bubbles: true }));
      });
    // Out-of-range drafts are flagged and never written.
    await type('512');
    await blur();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(change).not.toHaveBeenCalled();
    // Typing alone does not write; a valid value commits on blur.
    await type('6144');
    expect(change).not.toHaveBeenCalled();
    await blur();
    expect(change).toHaveBeenCalledExactlyOnceWith({ kind: 'budget', tokens: 6144 });
  });
});
