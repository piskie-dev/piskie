import { describe, expect, it } from 'vitest';
import type {
  ReasoningProfile,
  ReasoningSelection,
  ReasoningTransportPreset,
} from '../../../../shared/types/reasoning.js';
import {
  reasoningNativeParameters,
  resolveEffectiveReasoning,
} from '../reasoning-policy.js';

const effortProfile: ReasoningProfile = {
  mode: 'effort',
  options: [
    { kind: 'disabled' },
    { kind: 'effort', effort: 'low' },
    { kind: 'effort', effort: 'medium' },
    { kind: 'effort', effort: 'high' },
  ],
  defaultSelection: { kind: 'effort', effort: 'medium' },
  mandatory: false,
  transportPreset: 'openai-effort',
  replayPolicy: 'opaque-required',
};

describe('reasoning policy', () => {
  it('resolves Agent override before model, catalog, and provider defaults', () => {
    expect(resolveEffectiveReasoning({
      profile: effortProfile,
      modelDefault: { kind: 'effort', effort: 'low' },
      agentOverride: { kind: 'effort', effort: 'high' },
    })).toEqual({
      selection: { kind: 'effort', effort: 'high' },
      source: 'agent',
      nativeParameters: { reasoning_effort: 'high' },
    });
  });

  it('uses the binding default when the Agent does not override it', () => {
    expect(resolveEffectiveReasoning({
      profile: effortProfile,
      modelDefault: { kind: 'effort', effort: 'low' },
    })).toEqual({
      selection: { kind: 'effort', effort: 'low' },
      source: 'model',
      nativeParameters: { reasoning_effort: 'low' },
    });
  });

  it('falls through to the catalog default and then the provider default', () => {
    expect(resolveEffectiveReasoning({ profile: effortProfile })).toEqual({
      selection: { kind: 'effort', effort: 'medium' },
      source: 'catalog',
      nativeParameters: { reasoning_effort: 'medium' },
    });
    expect(resolveEffectiveReasoning({})).toEqual({
      selection: { kind: 'provider-default' },
      source: 'provider-default',
      nativeParameters: {},
    });
  });

  it('rejects a stale override that is not selectable for the chosen model', () => {
    expect(() => resolveEffectiveReasoning({
      profile: effortProfile,
      agentOverride: { kind: 'effort', effort: 'max' },
    })).toThrow('Agent reasoning override is not valid for the selected model');
  });
});

interface NativeCase {
  preset: ReasoningTransportPreset;
  selection: ReasoningSelection;
  expected: Record<string, unknown>;
}

const nativeCases: NativeCase[] = [
  { preset: 'none', selection: { kind: 'enabled' }, expected: {} },
  { preset: 'openai-effort', selection: { kind: 'effort', effort: 'high' }, expected: { reasoning_effort: 'high' } },
  { preset: 'openai-reasoning-object', selection: { kind: 'effort', effort: 'high' }, expected: { reasoning: { effort: 'high' } } },
  {
    preset: 'anthropic-adaptive-effort',
    selection: { kind: 'effort', effort: 'high' },
    expected: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
  },
  {
    preset: 'anthropic-budget',
    selection: { kind: 'budget', tokens: 4_096 },
    expected: { thinking: { type: 'enabled', budget_tokens: 4_096 } },
  },
  { preset: 'gemini-effort', selection: { kind: 'effort', effort: 'low' }, expected: { reasoning_effort: 'low' } },
  { preset: 'deepseek-thinking', selection: { kind: 'enabled' }, expected: { thinking: { type: 'enabled' } } },
  { preset: 'dashscope-enable-thinking', selection: { kind: 'disabled' }, expected: { enable_thinking: false } },
  { preset: 'minimax-thinking', selection: { kind: 'enabled' }, expected: { thinking: { type: 'enabled' } } },
  { preset: 'volcengine-reasoning', selection: { kind: 'enabled' }, expected: { thinking: { type: 'enabled' } } },
  { preset: 'together-reasoning', selection: { kind: 'budget', tokens: 2_048 }, expected: { reasoning: { max_tokens: 2_048 } } },
  { preset: 'fireworks-reasoning', selection: { kind: 'enabled' }, expected: { reasoning: { enabled: true } } },
  { preset: 'openrouter-reasoning', selection: { kind: 'effort', effort: 'medium' }, expected: { reasoning: { effort: 'medium' } } },
  { preset: 'ollama-think', selection: { kind: 'enabled' }, expected: { think: true } },
];

describe('reasoning wire presets', () => {
  it.each(nativeCases)('maps $preset without consulting a model-id table', ({ preset, selection, expected }) => {
    expect(reasoningNativeParameters(preset, selection)).toEqual(expected);
  });
});
