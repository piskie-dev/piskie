import { describe, expect, it } from 'vitest';
import i18n from 'i18next';
import type { ReasoningProfile } from '../../../shared/types/reasoning';
import '@/i18n';
import {
  getSelectableReasoningOptions,
  modelReasoningSummary,
  reasoningOptionKey,
  resolveSelectableReasoning,
} from '../reasoning-options';

const translate = (key: string, values?: Readonly<Record<string, string | number>>) => (
  i18n.t(key, values ?? {})
);

const profile: ReasoningProfile = {
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

describe('reasoning options', () => {
  it('hides defaults and disabled states from user choices', () => {
    expect(getSelectableReasoningOptions(profile).map(reasoningOptionKey)).toEqual([
      'effort:low',
      'effort:medium',
      'effort:high',
    ]);
  });

  it('highlights the model default without adding a default option', () => {
    expect(reasoningOptionKey(resolveSelectableReasoning(profile)!)).toBe('effort:medium');
  });

  it('maps a legacy disabled selection to the real low effort level', () => {
    expect(reasoningOptionKey(resolveSelectableReasoning(profile, { kind: 'disabled' })!)).toBe('effort:low');
  });

  it('summarizes the configured model default in user-facing language', () => {
    expect(modelReasoningSummary(profile, { kind: 'effort', effort: 'high' }, translate)).toBe('思考 高');
    expect(modelReasoningSummary(profile, undefined, translate)).toBe('思考 中');
  });
});
