import type { WorkerPreferences } from '../../../shared/types/worker-preferences';
import type { ModelTarget } from '../../../shared/types/inference';
import type { ReasoningSelection } from '../../../shared/types/reasoning';
import type { ModelOptGroup } from '../../store/inferenceStore';
import { formatModelReference } from '../../store/inferenceStore';
import type { ConfigFieldMutation } from '../config/config-transaction';
import { isReasoningInputValid } from '../../utils/reasoning-capabilities';
import { resolveSelectableReasoning } from '../../utils/reasoning-options';

export type InferenceDraft =
  | { mode: 'inherit' }
  | { mode: 'fixed'; target?: ModelTarget; reasoning?: ReasoningSelection }
  | { mode: 'remove' };
export interface WorkerDraft {
  base?: WorkerPreferences;
  value: InferenceDraft;
  displayName: string;
  conflict: boolean;
}
export function fromProfile(profile?: WorkerPreferences): InferenceDraft {
  return profile?.inference
    ? { mode: 'fixed', ...structuredClone(profile.inference) }
    : { mode: 'inherit' };
}
export function sameValue(a: unknown, b: unknown): boolean {
  // JSON object key order is not significant for configuration snapshots.
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)])
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** Match ModelForge's default selection, including legacy defaults outside its selectable set. */
export function modelDefaultReasoning(
  option: ModelOptGroup['options'][number]
): ReasoningSelection {
  const profile = option.definition.reasoning;
  const requested: ReasoningSelection = option.defaultReasoning ??
    profile?.defaultSelection ?? { kind: 'provider-default' };
  return profile && profile.mode !== 'none'
    ? (resolveSelectableReasoning(profile, requested) ?? requested)
    : requested;
}

export function chooseModel(
  draft: InferenceDraft,
  option: ModelOptGroup['options'][number]
): InferenceDraft {
  if (draft.mode === 'fixed' && draft.target && formatModelReference(draft.target) === option.value)
    return draft;
  return {
    mode: 'fixed',
    target: option.target,
    reasoning: structuredClone(modelDefaultReasoning(option)),
  };
}
export function draftProblem(
  draft: InferenceDraft,
  groups: ModelOptGroup[]
): 'chooseModel' | 'modelUnavailable' | 'reasoningInvalid' | undefined {
  if (draft.mode !== 'fixed') return;
  if (!draft.target) return 'chooseModel';
  const model = groups
    .flatMap((group) => group.options)
    .find((option) => option.value === formatModelReference(draft.target!));
  if (!model) return 'modelUnavailable';
  if (!isReasoningInputValid(draft.reasoning, model.definition.reasoning))
    return 'reasoningInvalid';
  return undefined;
}
export function inferenceMutations(
  type: string,
  profile: WorkerPreferences | undefined,
  draft: InferenceDraft
): ConfigFieldMutation[] {
  const bindings = { type };
  if (draft.mode === 'remove')
    return profile ? [{ op: 'remove', pathTemplate: '/profiles/{type}', bindings }] : [];
  if (draft.mode === 'inherit') {
    if (!profile?.inference) return [];
    return [
      {
        op: 'remove',
        pathTemplate:
          Object.keys(profile).length === 1 ? '/profiles/{type}' : '/profiles/{type}/inference',
        bindings,
      },
    ];
  }
  if (!draft.target || !draft.reasoning) throw new Error('Incomplete inference preference');
  const inference = { target: draft.target, reasoning: draft.reasoning };
  return [
    {
      op: 'set',
      pathTemplate: profile ? '/profiles/{type}/inference' : '/profiles/{type}',
      bindings,
      value: profile ? inference : { inference },
    },
  ];
}
export function reconcileDrafts(
  drafts: Record<string, WorkerDraft>,
  profiles: Record<string, WorkerPreferences>
): Record<string, WorkerDraft> {
  return Object.fromEntries(
    Object.entries(drafts).flatMap(([type, draft]) => {
      const latest = profiles[type];
      if (
        (sameValue(draft.value, fromProfile(latest)) &&
          draft.displayName.trim() === (latest?.displayName ?? '')) ||
        (draft.value.mode === 'remove' && !latest)
      )
        return [];
      return [[type, { ...draft, conflict: draft.conflict || !sameValue(draft.base, latest) }]];
    })
  );
}

/** One transaction for the current type; remarks and inference remain independent fields. */
export function preferenceMutations(
  type: string,
  profile: WorkerPreferences | undefined,
  draft: WorkerDraft
): ConfigFieldMutation[] {
  if (draft.value.mode === 'remove') return inferenceMutations(type, profile, draft.value);
  const bindings = { type };
  const displayName = draft.displayName.trim();
  const inferenceChanged = !sameValue(draft.value, fromProfile(profile));
  if (!profile) {
    const next: WorkerPreferences = {};
    if (displayName) next.displayName = displayName;
    if (draft.value.mode === 'fixed') {
      if (!draft.value.target || !draft.value.reasoning)
        throw new Error('Incomplete inference preference');
      next.inference = { target: draft.value.target, reasoning: draft.value.reasoning };
    }
    return Object.keys(next).length
      ? [{ op: 'set', pathTemplate: '/profiles/{type}', bindings, value: next }]
      : [];
  }
  const next = { ...profile };
  if (displayName) next.displayName = displayName;
  else delete next.displayName;
  if (draft.value.mode === 'inherit') delete next.inference;
  else {
    if (!draft.value.target || !draft.value.reasoning)
      throw new Error('Incomplete inference preference');
    next.inference = { target: draft.value.target, reasoning: draft.value.reasoning };
  }
  if (!Object.keys(next).length)
    return [{ op: 'remove', pathTemplate: '/profiles/{type}', bindings }];
  const changes: ConfigFieldMutation[] = [];
  if (displayName !== (profile.displayName ?? '')) {
    changes.push(
      displayName
        ? { op: 'set', pathTemplate: '/profiles/{type}/displayName', bindings, value: displayName }
        : { op: 'remove', pathTemplate: '/profiles/{type}/displayName', bindings }
    );
  }
  if (inferenceChanged) {
    // Profile stays alive when it contains a remark or another configuration section.
    changes.push(...inferenceMutations(type, { ...profile, ...next }, draft.value));
  }
  return changes;
}
