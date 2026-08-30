import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceModelDefinition } from '../../../../shared/types/inference';
import type { ModelOptGroup } from '../../../store/inferenceStore';
import { reasoningSelectionLabel } from '../../../utils/reasoning-options';

import '../../../i18n';

import ModelReasoningControl from '../ModelReasoningControl';

const translate = (key: string, values?: Readonly<Record<string, string | number>>) => (
  i18n.t(key, values ?? {})
);

afterEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('reasoningSelectionLabel', () => {
  it('uses compact localized labels for effort controls', () => {
    expect(reasoningSelectionLabel({ kind: 'effort', effort: 'minimal' }, true, translate)).toBe('最小');
    expect(reasoningSelectionLabel({ kind: 'effort', effort: 'xhigh' }, true, translate)).toBe('超高');
    expect(reasoningSelectionLabel({ kind: 'effort', effort: 'max' }, true, translate)).toBe('最大');
  });

  it('uses Max only for the localized compact English label', async () => {
    await i18n.changeLanguage('en-US');

    expect(reasoningSelectionLabel({ kind: 'effort', effort: 'max' }, true, translate)).toBe('Max');
    expect(reasoningSelectionLabel({ kind: 'effort', effort: 'max' }, false, translate)).toBe('Maximum');
  });

  it('formats toggles and token budgets without exposing transport details', () => {
    expect(reasoningSelectionLabel({ kind: 'enabled' }, false, translate)).toBe('开启');
    expect(reasoningSelectionLabel({ kind: 'disabled' }, false, translate)).toBe('关闭');
    expect(reasoningSelectionLabel({ kind: 'budget', tokens: 8192 }, true, translate)).toBe('8.2K');
  });
});

describe('ModelReasoningControl', () => {
  it('shows the model and compact effort without a redundant Reasoning prefix', async () => {
    const maxReasoning = { kind: 'effort', effort: 'max' } as const;
    const definition: InferenceModelDefinition = {
      id: 'gpt-5.6',
      displayName: 'GPT-5.6',
      kind: 'ai',
      lifecycle: 'active',
      compatibleDrivers: ['openai'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      capabilities: { reasoning: true },
      reasoning: {
        mode: 'effort',
        options: [maxReasoning],
        defaultSelection: maxReasoning,
        mandatory: false,
        transportPreset: 'openai-effort',
        replayPolicy: 'opaque-required',
      },
      limits: {},
      source: { kind: 'bundled', version: 'test' },
    };
    const modelGroups: ModelOptGroup[] = [{
      label: 'OpenAI',
      options: [{
        label: 'GPT-5.6',
        value: 'openai::gpt-5.6',
        target: { providerId: 'openai', modelId: 'gpt-5.6' },
        definition,
        defaultReasoning: maxReasoning,
      }],
    }];
    await i18n.changeLanguage('en-US');

    const markup = renderToStaticMarkup(createElement(ModelReasoningControl, {
      modelGroups,
      model: 'openai::gpt-5.6',
      onModelChange: vi.fn(),
      onReasoningChange: vi.fn(),
      variant: 'full',
    }));

    expect(markup).toMatch(/>GPT-5\.6<\/span><span[^>]*>Max<\/span>/);
    expect(markup).not.toContain('>Reasoning</span>');
    expect(markup).not.toContain('>Maximum</span>');
  });
});
