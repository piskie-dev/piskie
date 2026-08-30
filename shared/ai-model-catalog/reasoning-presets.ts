import type {
  ReasoningProfile,
  ReasoningSelection,
  ReasoningTransportPreset,
} from '../types/reasoning.js';

const providerDefault: ReasoningSelection = { kind: 'provider-default' };
const OPENAI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const NO_REASONING: ReasoningProfile = {
  mode: 'none',
  options: [providerDefault],
  defaultSelection: providerDefault,
  mandatory: false,
  transportPreset: 'none',
  replayPolicy: 'none',
};

function effortProfile(
  efforts: Array<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>,
  defaultEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  transportPreset: ReasoningProfile['transportPreset'],
  options: { mandatory?: boolean; replayPolicy?: ReasoningProfile['replayPolicy'] } = {},
): ReasoningProfile {
  return {
    mode: 'effort',
    options: efforts.map((effort) => effort === 'none'
      ? { kind: 'disabled' as const }
      : { kind: 'effort' as const, effort }),
    defaultSelection: defaultEffort === 'none'
      ? { kind: 'disabled' }
      : { kind: 'effort', effort: defaultEffort },
    mandatory: options.mandatory ?? false,
    transportPreset,
    replayPolicy: options.replayPolicy ?? 'visible',
  };
}

function toggleProfile(
  defaultEnabled: boolean,
  transportPreset: ReasoningProfile['transportPreset'],
  options: { mandatory?: boolean; replayPolicy?: ReasoningProfile['replayPolicy'] } = {},
): ReasoningProfile {
  const mandatory = options.mandatory ?? false;
  return {
    mode: mandatory ? 'fixed' : 'toggle',
    options: mandatory
      ? [{ kind: 'enabled' }]
      : [{ kind: 'disabled' }, { kind: 'enabled' }],
    defaultSelection: defaultEnabled ? { kind: 'enabled' } : { kind: 'disabled' },
    mandatory,
    transportPreset,
    replayPolicy: options.replayPolicy ?? 'visible',
  };
}

function budgetEnvironment(
  defaultTokens: number,
  minBudgetTokens: number,
  maxBudgetTokens: number,
  transportPreset: ReasoningProfile['transportPreset'],
): ReasoningProfile {
  return {
    mode: 'budget',
    options: [{ kind: 'disabled' }, { kind: 'budget', tokens: defaultTokens }],
    defaultSelection: { kind: 'budget', tokens: defaultTokens },
    mandatory: false,
    transportPreset,
    replayPolicy: 'opaque-required',
    minBudgetTokens,
    maxBudgetTokens,
  };
}

export function profileForReasoningTransport(
  transportPreset: ReasoningTransportPreset,
): ReasoningProfile {
  switch (transportPreset) {
    case 'none':
      return NO_REASONING;
    case 'openai-effort':
    case 'openai-reasoning-object':
      return effortProfile(['none', ...OPENAI_EFFORTS], 'medium', transportPreset);
    case 'gemini-effort':
    case 'openrouter-reasoning':
      return effortProfile(['none', 'low', 'medium', 'high'], 'medium', transportPreset);
    case 'anthropic-adaptive-effort':
      return effortProfile(['low', 'medium', 'high', 'max'], 'high', transportPreset);
    case 'anthropic-budget':
      return budgetEnvironment(8_000, 1_024, 64_000, transportPreset);
    default:
      return toggleProfile(true, transportPreset);
  }
}

export function normalizeReasoningProfile(profile: ReasoningProfile): ReasoningProfile {
  if (profile.mode !== 'effort'
    || (profile.transportPreset !== 'openai-effort'
      && profile.transportPreset !== 'openai-reasoning-object')) {
    return profile;
  }
  const nonEffortOptions = profile.options.filter((option) => option.kind !== 'effort');
  return {
    ...profile,
    options: [
      ...nonEffortOptions,
      ...OPENAI_EFFORTS.map((effort) => ({ kind: 'effort' as const, effort })),
    ],
  };
}
