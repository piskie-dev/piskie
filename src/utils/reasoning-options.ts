import type {
  ReasoningProfile,
  ReasoningSelection,
} from '../../shared/types/reasoning';

const effortLabelKeys = {
  none: 'reasoning.effort.none',
  minimal: 'reasoning.effort.minimal',
  low: 'reasoning.effort.low',
  medium: 'reasoning.effort.medium',
  high: 'reasoning.effort.high',
  xhigh: 'reasoning.effort.xhigh',
  max: 'reasoning.effort.max',
} as const;

const compactEffortLabelKeys = {
  max: 'reasoning.compactEffort.max',
} as const;

export type ReasoningTranslator = (
  key: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

export function reasoningSelectionLabel(
  selection: ReasoningSelection | undefined,
  compact: boolean,
  translate: ReasoningTranslator,
): string {
  if (!selection) return translate(compact ? 'reasoning.default' : 'reasoning.modelDefault');
  if (selection.kind === 'effort') {
    const compactKey = selection.effort === 'max'
      ? compactEffortLabelKeys.max
      : undefined;
    return translate(compact && compactKey ? compactKey : effortLabelKeys[selection.effort]);
  }
  if (selection.kind === 'budget') {
    const value = selection.tokens >= 1000
      ? `${Math.round(selection.tokens / 100) / 10}K`
      : String(selection.tokens);
    return compact ? value : translate('reasoning.budget', { value });
  }
  if (selection.kind === 'enabled') return translate('reasoning.enabled');
  if (selection.kind === 'disabled') return translate('reasoning.disabled');
  return translate(compact ? 'reasoning.default' : 'reasoning.providerDefault');
}

export function modelReasoningSummary(
  profile: ReasoningProfile | undefined,
  configuredDefault: ReasoningSelection | undefined,
  translate: ReasoningTranslator,
): string {
  if (!profile) return translate('reasoning.unknown');
  if (profile.mode === 'none') return translate('reasoning.none');
  const selection = resolveSelectableReasoning(
    profile,
    configuredDefault ?? profile.defaultSelection,
  );
  if (!selection) return translate('reasoning.notConfigurable');
  const value = reasoningSelectionLabel(selection, true, translate);
  return translate('reasoning.summary', { value });
}

export function reasoningOptionKey(selection: ReasoningSelection): string {
  if (selection.kind === 'effort') return `effort:${selection.effort}`;
  if (selection.kind === 'budget') return 'budget';
  return selection.kind;
}

export function getSelectableReasoningOptions(profile: ReasoningProfile): ReasoningSelection[] {
  const seen = new Set<string>();
  return profile.options.filter((option) => {
    if (option.kind === 'provider-default' || option.kind === 'disabled') return false;
    if (option.kind === 'effort' && option.effort === 'none') return false;
    const key = reasoningOptionKey(option);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveSelectableReasoning(
  profile: ReasoningProfile,
  preferred?: ReasoningSelection,
): ReasoningSelection | undefined {
  const options = getSelectableReasoningOptions(profile);
  const matching = preferred
    && options.find((option) => reasoningOptionKey(option) === reasoningOptionKey(preferred));
  if (matching) return preferred;

  if (preferred?.kind === 'disabled'
    || (preferred?.kind === 'effort' && preferred.effort === 'none')) {
    const low = options.find((option) => option.kind === 'effort' && option.effort === 'low');
    if (low) return low;
  }

  const defaultOption = options.find(
    (option) => reasoningOptionKey(option) === reasoningOptionKey(profile.defaultSelection),
  );
  return defaultOption ?? options[0];
}
