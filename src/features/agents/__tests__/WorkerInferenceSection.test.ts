import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { ReasoningProfile, ReasoningSelection } from '../../../../shared/types/reasoning';
import type { ModelOptGroup } from '../../../store/inferenceStore';
import { WorkerInferenceSection } from '../WorkerInferenceSection';
import '../../../i18n';

function modelGroup(
  options: ReasoningSelection[],
  selected: ReasoningSelection,
  mode: ReasoningProfile['mode'] = 'effort'
): ModelOptGroup {
  return {
    label: 'Provider',
    options: [
      {
        label: 'Model',
        value: 'p::model',
        target: { providerId: 'p', modelId: 'model' },
        defaultReasoning: selected,
        definition: {
          id: 'model',
          displayName: 'Model',
          kind: 'ai',
          lifecycle: 'active',
          compatibleDrivers: [],
          inputModalities: ['text'],
          outputModalities: ['text'],
          capabilities: {},
          limits: {},
          source: { kind: 'local', version: 'test' },
          reasoning: {
            mode,
            options,
            defaultSelection: selected,
            mandatory: false,
            transportPreset: 'openai-effort',
            replayPolicy: 'none',
          },
        },
      },
    ],
  };
}

function renderReasoning(
  options: ReasoningSelection[],
  selected: ReasoningSelection,
  mode: ReasoningProfile['mode'] = 'effort'
) {
  const group = modelGroup(options, selected, mode);
  const edit = vi.fn();
  const markup = renderToStaticMarkup(
    React.createElement(WorkerInferenceSection, {
      groups: [group],
      value: { mode: 'fixed', target: group.options[0]!.target, reasoning: selected },
      saving: false,
      edit,
      modelError: null,
      onConfigureModels: vi.fn(),
      onRefresh: vi.fn(),
    })
  );
  const dom = new JSDOM(markup);
  try {
    const section = [...dom.window.document.querySelectorAll('section')].find(
      (el) => el.querySelector('h3')?.textContent === '思考设置'
    )!;
    return {
      buttons: [...section.querySelectorAll('button')].map((el) => el.textContent),
      selected: section.querySelector('button[aria-pressed="true"]')?.textContent,
      text: section.textContent,
      budget: section.querySelector('input[type="number"]')?.getAttribute('value'),
      edit,
    };
  } finally {
    dom.window.close();
  }
}

describe('Agent reasoning matches model settings', () => {
  const efforts: ReasoningSelection[] = [
    { kind: 'provider-default' },
    { kind: 'disabled' },
    { kind: 'effort', effort: 'none' },
    { kind: 'effort', effort: 'low' },
    { kind: 'effort', effort: 'high' },
  ];
  it('offers only the same concrete effort choices as the model settings page', () => {
    const view = renderReasoning(efforts, { kind: 'effort', effort: 'high' });
    expect(view.buttons).toEqual(['低', '高']);
    expect(view.selected).toBe('高');
    expect(view.edit).not.toHaveBeenCalled();
  });
  it('keeps an existing off selection visible as a value, without offering an off button or silently changing it', () => {
    const view = renderReasoning(efforts, { kind: 'disabled' });
    expect(view.buttons).toEqual(['低', '高']);
    expect(view.text).toContain('当前思考：关闭');
    expect(view.selected).toBeUndefined();
    expect(view.edit).not.toHaveBeenCalled();
  });
  it('retains the configured token budget without adding an off choice', () => {
    const view = renderReasoning(
      [{ kind: 'disabled' }, { kind: 'budget', tokens: 2048 }],
      { kind: 'budget', tokens: 8192 },
      'budget'
    );
    expect(view.buttons).toEqual(['预算 2K']);
    expect(view.budget).toBe('8192');
  });
});

describe('Stranded saved model', () => {
  const group = modelGroup([{ kind: 'effort', effort: 'low' }], { kind: 'effort', effort: 'low' });
  const render = (degraded: boolean) =>
    renderToStaticMarkup(
      React.createElement(WorkerInferenceSection, {
        groups: [group],
        value: {
          mode: 'fixed',
          target: { providerId: 'gone', modelId: 'old' },
          reasoning: { kind: 'effort', effort: 'low' },
        },
        degraded,
        saving: false,
        edit: vi.fn(),
        modelError: null,
        onConfigureModels: vi.fn(),
        onRefresh: vi.fn(),
      })
    );
  const pressed = (markup: string) => {
    const dom = new JSDOM(markup);
    try {
      const section = [...dom.window.document.querySelectorAll('section')].find(
        (el) => el.querySelector('h3')?.textContent === '模型来源'
      )!;
      return [...section.querySelectorAll('button[aria-pressed="true"]')].map(
        (el) => el.querySelector('strong')?.textContent
      );
    } finally {
      dom.window.close();
    }
  };
  it('shows the effective inheritance with the saved target kept for reselection', () => {
    const markup = render(true);
    expect(pressed(markup)).toEqual(['继承父 Agent']);
    expect(markup).toContain('gone / old');
    expect(markup).toContain('重新选择模型');
    expect(markup).not.toContain('此模型当前不可用');
    expect(markup).not.toContain('<h3>模型</h3>');
    expect(markup).not.toContain('<h3>思考设置</h3>');
  });
  it('still edits the saved target as a fixed model once the draft changes', () => {
    const markup = render(false);
    expect(pressed(markup)).toEqual(['指定模型']);
    expect(markup).toContain('此模型当前不可用');
  });
});
