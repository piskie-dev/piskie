import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../ModelPicker';
import type { ModelOptGroup } from '../../../../../store/inferenceStore';

vi.mock('../../../chrome/Popover', () => ({
  Popover: ({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, trigger, children),
}));
const profile = {
  mode: 'effort',
  options: [
    { kind: 'disabled' },
    { kind: 'effort', effort: 'low' },
    { kind: 'effort', effort: 'high' },
  ],
  defaultSelection: { kind: 'effort', effort: 'high' },
  mandatory: false,
};
function groups(defaultReasoning: unknown): ModelOptGroup[] {
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
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
  vi.unstubAllGlobals();
});
describe('ModelPicker actual Worker reasoning', () => {
  it('displays the actual selection without writing on mount or model-default refresh', async () => {
    const change = vi.fn().mockResolvedValue(undefined);
    const render = (defaultReasoning: unknown) =>
      act(async () =>
        root.render(
          React.createElement(ModelPicker, {
            model: 'p::model',
            modelGroups: groups(defaultReasoning),
            reasoning: { kind: 'disabled' },
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

  it('preserves the original main Agent default normalization', async () => {
    const change = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        React.createElement(ModelPicker, {
          model: 'p::model',
          modelGroups: groups({ kind: 'disabled' }),
          onModelChange: vi.fn(),
          onReasoningChange: change,
        })
      )
    );
    expect(change).toHaveBeenCalledWith({ kind: 'effort', effort: 'low' });
  });
});
