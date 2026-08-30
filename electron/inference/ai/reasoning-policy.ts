import type {
  ReasoningProfile,
  ReasoningSelection,
  ReasoningTransportPreset,
} from '../../../shared/types/reasoning.js';
import type { ReasoningRequest } from './contracts.js';

export type EffectiveReasoningSource = 'agent' | 'model' | 'catalog' | 'provider-default';

export interface EffectiveReasoning {
  selection: ReasoningSelection;
  source: EffectiveReasoningSource;
  nativeParameters: Record<string, unknown>;
}

export class ReasoningSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReasoningSelectionError';
  }
}

export function resolveEffectiveReasoning(input: {
  profile?: ReasoningProfile;
  modelDefault?: ReasoningSelection;
  agentOverride?: ReasoningSelection;
}): EffectiveReasoning {
  const { profile, modelDefault, agentOverride } = input;
  if (agentOverride) {
    assertSelectionAllowed(agentOverride, profile, 'Agent reasoning override');
    return effective(agentOverride, 'agent', profile?.transportPreset);
  }
  if (modelDefault) {
    assertSelectionAllowed(modelDefault, profile, 'Model default reasoning');
    return effective(modelDefault, 'model', profile?.transportPreset);
  }
  if (profile) {
    assertSelectionAllowed(profile.defaultSelection, profile, 'Catalog default reasoning');
    return effective(profile.defaultSelection, 'catalog', profile.transportPreset);
  }
  return effective({ kind: 'provider-default' }, 'provider-default');
}

export function isReasoningSelectionAllowed(
  selection: ReasoningSelection,
  profile?: ReasoningProfile,
): boolean {
  if (!profile) return selection.kind === 'provider-default';
  if (selection.kind === 'budget') {
    if (profile.mode !== 'budget' && profile.mode !== 'effort-or-budget') return false;
    if (profile.minBudgetTokens !== undefined && selection.tokens < profile.minBudgetTokens) return false;
    if (profile.maxBudgetTokens !== undefined && selection.tokens > profile.maxBudgetTokens) return false;
    return profile.options.some((option) => option.kind === 'budget');
  }
  return profile.options.some((option) => sameSelection(option, selection));
}

export function reasoningRequest(selection: ReasoningSelection): ReasoningRequest | undefined {
  switch (selection.kind) {
    case 'provider-default':
      return undefined;
    case 'disabled':
      return { kind: 'disabled' };
    case 'enabled':
      return { kind: 'enabled' };
    case 'budget':
      return { kind: 'budget', tokens: selection.tokens };
    case 'effort':
      return selection.effort === 'none'
        ? { kind: 'disabled' }
        : { kind: 'effort', effort: selection.effort };
  }
}

export function selectionFromReasoningRequest(request?: ReasoningRequest): ReasoningSelection {
  if (!request) return { kind: 'provider-default' };
  if (request.kind === 'effort') return { kind: 'effort', effort: request.effort };
  if (request.kind === 'budget') return { kind: 'budget', tokens: request.tokens };
  return { kind: request.kind };
}

export function reasoningNativeParameters(
  transportPreset: ReasoningTransportPreset | undefined,
  selection: ReasoningSelection,
): Record<string, unknown> {
  if (!transportPreset || transportPreset === 'none' || selection.kind === 'provider-default') return {};
  const isEnabled = selection.kind !== 'disabled'
    && !(selection.kind === 'effort' && selection.effort === 'none');

  switch (transportPreset) {
    case 'openai-effort':
    case 'gemini-effort':
      if (selection.kind === 'disabled') return { reasoning_effort: 'none' };
      return selection.kind === 'effort' ? { reasoning_effort: selection.effort } : {};
    case 'openai-reasoning-object':
      if (selection.kind === 'disabled') return { reasoning: { effort: 'none' } };
      return selection.kind === 'effort' ? { reasoning: { effort: selection.effort } } : {};
    case 'anthropic-adaptive-effort':
      if (selection.kind === 'disabled') return { thinking: { type: 'disabled' } };
      return selection.kind === 'effort'
        ? { thinking: { type: 'adaptive' }, output_config: { effort: selection.effort } }
        : {};
    case 'anthropic-budget':
      if (selection.kind === 'disabled') return { thinking: { type: 'disabled' } };
      return selection.kind === 'budget'
        ? { thinking: { type: 'enabled', budget_tokens: selection.tokens } }
        : {};
    case 'deepseek-thinking':
    case 'minimax-thinking':
    case 'volcengine-reasoning':
      return { thinking: { type: isEnabled ? 'enabled' : 'disabled' } };
    case 'dashscope-enable-thinking':
      return { enable_thinking: isEnabled };
    case 'together-reasoning':
    case 'fireworks-reasoning':
      return selection.kind === 'budget'
        ? { reasoning: { max_tokens: selection.tokens } }
        : { reasoning: { enabled: isEnabled } };
    case 'openrouter-reasoning':
      if (selection.kind === 'effort') return { reasoning: { effort: selection.effort } };
      if (selection.kind === 'budget') return { reasoning: { max_tokens: selection.tokens } };
      return { reasoning: { enabled: isEnabled } };
    case 'ollama-think':
      return { think: isEnabled };
    default:
      return {};
  }
}

function effective(
  selection: ReasoningSelection,
  source: EffectiveReasoningSource,
  transportPreset?: ReasoningTransportPreset,
): EffectiveReasoning {
  return {
    selection,
    source,
    nativeParameters: reasoningNativeParameters(transportPreset, selection),
  };
}

function assertSelectionAllowed(
  selection: ReasoningSelection,
  profile: ReasoningProfile | undefined,
  label: string,
): void {
  if (!isReasoningSelectionAllowed(selection, profile)) {
    throw new ReasoningSelectionError(`${label} is not valid for the selected model`);
  }
}

function sameSelection(left: ReasoningSelection, right: ReasoningSelection): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'effort' && right.kind === 'effort') return left.effort === right.effort;
  if (left.kind === 'budget' && right.kind === 'budget') return left.tokens === right.tokens;
  return true;
}
