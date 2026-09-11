import type { ReasoningProfile, ReasoningSelection } from '../../shared/types/reasoning';
import { reasoningOptionKey } from './reasoning-options';

/** Form validation only; the Agent inference port remains authoritative. */
export function isReasoningInputValid(
  selection: ReasoningSelection | undefined,
  profile?: ReasoningProfile
): boolean {
  if (!selection) return false;
  if (!profile) return selection.kind === 'provider-default';
  if (selection.kind === 'budget') {
    return (
      (profile.mode === 'budget' || profile.mode === 'effort-or-budget') &&
      profile.options.some((option) => option.kind === 'budget') &&
      Number.isInteger(selection.tokens) &&
      selection.tokens >= (profile.minBudgetTokens ?? 1) &&
      selection.tokens <= (profile.maxBudgetTokens ?? Infinity)
    );
  }
  return profile.options.some(
    (option) => reasoningOptionKey(option) === reasoningOptionKey(selection)
  );
}
