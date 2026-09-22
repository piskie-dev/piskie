import {
  FIXED_SHORTCUT_LAYERS,
  type ShortcutBinding,
  type ShortcutConflict,
  type ShortcutDispatchResult,
  type ShortcutKeyEvent,
  type ShortcutLayer,
  type ShortcutScope,
} from './types';

interface ScopeDefinition {
  readonly bindings: readonly ShortcutBinding[];
}

interface ScopeRecord {
  readonly id: string;
  readonly layer: ShortcutLayer;
  readonly parentScopeId?: string;
  readonly blocksLowerLayers: 'none' | 'all';
  readonly sequence: number;
  readonly definitions: Map<symbol, ScopeDefinition>;
  readonly bindings: Map<symbol, ShortcutBinding>;
}

interface ShortcutRegistryState {
  readonly scopes: Map<string, ScopeRecord>;
  readonly pendingBindings: Map<string, Map<symbol, ShortcutBinding>>;
  focusedScopeId: string | null;
  ownerScopeId: string | null;
  sequence: number;
}

export interface ShortcutRouter {
  registerScope: (scope: ShortcutScope) => () => void;
  registerBinding: (scopeId: string, binding: ShortcutBinding) => () => void;
  activateFocusedScope: (scopeId: string | null) => void;
  activateOwnerScope: (scopeId: string | null) => void;
  getFocusedScope: () => string | null;
  getOwnerScope: () => string | null;
  hasActiveOverlay: () => boolean;
  dispatch: (event: ShortcutKeyEvent) => ShortcutDispatchResult;
  reset: () => void;
}

export interface CreateShortcutRouterOptions {
  readonly onConflict?: (conflict: ShortcutConflict) => void;
}

interface Match {
  readonly scope: ScopeRecord;
  readonly binding: ShortcutBinding;
}

interface PositionEvaluation {
  readonly matches: readonly Match[];
  readonly blockers: readonly ScopeRecord[];
}

const REGISTRY_KEY = '__piskieApplicationShortcutRegistryV1';

function createRegistryState(): ShortcutRegistryState {
  return {
    scopes: new Map(),
    pendingBindings: new Map(),
    focusedScopeId: null,
    ownerScopeId: null,
    sequence: 0,
  };
}

function defaultConflictReporter(conflict: ShortcutConflict): void {
  console.error(
    `[shortcuts] Ambiguous ${conflict.combo} binding in ${conflict.layer}: ${conflict.bindingIds.join(', ')}`,
    conflict,
  );
}

function sameScopeMetadata(record: ScopeRecord, scope: ShortcutScope): boolean {
  return record.layer === scope.layer
    && record.parentScopeId === scope.parentScopeId
    && record.blocksLowerLayers === scope.blocksLowerLayers;
}

function bindingMatchesEvent(
  binding: ShortcutBinding,
  event: ShortcutKeyEvent,
  concreteCombo: string,
  legacyCombo: string,
): boolean {
  const combo = binding.combo.toLowerCase();
  if (combo !== concreteCombo && combo !== legacyCombo) return false;
  if (event.editableTarget && !binding.allowInEditable) return false;
  if (event.repeat && !binding.repeat) return false;
  return binding.enabled();
}

function bindingsOf(scope: ScopeRecord): readonly ShortcutBinding[] {
  return [
    ...Array.from(scope.definitions.values()).flatMap((definition) => definition.bindings),
    ...scope.bindings.values(),
  ];
}

function evaluatePosition(
  scopes: readonly ScopeRecord[],
  event: ShortcutKeyEvent,
  concreteCombo: string,
  legacyCombo: string,
): PositionEvaluation {
  const matches: Match[] = [];
  const blockers: ScopeRecord[] = [];

  for (const scope of scopes) {
    if (scope.blocksLowerLayers === 'all') blockers.push(scope);
    for (const binding of bindingsOf(scope)) {
      if (bindingMatchesEvent(binding, event, concreteCombo, legacyCombo)) {
        matches.push({ scope, binding });
      }
    }
  }

  return { matches, blockers };
}

function orderedOverlayScopes(scopes: ReadonlyMap<string, ScopeRecord>): readonly ScopeRecord[] {
  const overlays = Array.from(scopes.values()).filter((scope) => scope.layer === 'overlay');
  const ordered: ScopeRecord[] = [];
  const remaining = new Map(overlays.map((scope) => [scope.id, scope]));

  while (remaining.size > 0) {
    const leaves = Array.from(remaining.values()).filter((candidate) => (
      !Array.from(remaining.values()).some((scope) => scope.parentScopeId === candidate.id)
    ));
    const candidates = leaves.length > 0 ? leaves : Array.from(remaining.values());
    candidates.sort((left, right) => right.sequence - left.sequence);
    const next = candidates[0];
    if (!next) break;
    ordered.push(next);
    remaining.delete(next.id);
  }
  return ordered;
}

function hasAncestor(
  candidate: ScopeRecord,
  ancestorId: string,
  scopes: ReadonlyMap<string, ScopeRecord>,
): boolean {
  const visited = new Set<string>();
  let parentId = candidate.parentScopeId;
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = scopes.get(parentId)?.parentScopeId;
  }
  return false;
}

function removeScopeTree(state: ShortcutRegistryState, scopeId: string): void {
  const removedIds = new Set<string>([scopeId]);
  for (const scope of state.scopes.values()) {
    if (hasAncestor(scope, scopeId, state.scopes)) removedIds.add(scope.id);
  }
  for (const id of removedIds) {
    state.scopes.delete(id);
    state.pendingBindings.delete(id);
  }
  if (state.focusedScopeId && removedIds.has(state.focusedScopeId)) state.focusedScopeId = null;
  if (state.ownerScopeId && removedIds.has(state.ownerScopeId)) state.ownerScopeId = null;
}

function physicalCombo(event: ShortcutKeyEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.metaKey) parts.push('meta');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(canonicalEventKey(event.key));
  return parts.join('+');
}

function legacyModCombo(event: ShortcutKeyEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(canonicalEventKey(event.key));
  return parts.join('+');
}

function canonicalEventKey(key: string): string {
  if (key === ' ') return 'space';
  if (key === '+') return 'plus';
  const normalized = key.toLowerCase();
  if (normalized === 'esc') return 'escape';
  if (normalized === 'spacebar') return 'space';
  return normalized;
}

export function canonicalComboFromEvent(event: ShortcutKeyEvent): string {
  return physicalCombo(event);
}

function createRouter(
  state: ShortcutRegistryState,
  onConflict: (conflict: ShortcutConflict) => void,
): ShortcutRouter {
  const finishPosition = (
    layer: ShortcutLayer,
    evaluation: PositionEvaluation,
    combo: string,
    event: ShortcutKeyEvent,
  ): ShortcutDispatchResult | null => {
    if (evaluation.matches.length > 1) {
      const conflict: ShortcutConflict = {
        combo,
        layer,
        scopeIds: [...new Set(evaluation.matches.map((match) => match.scope.id))],
        bindingIds: evaluation.matches.map((match) => match.binding.id),
      };
      onConflict(conflict);
      return { kind: 'conflict', ...conflict };
    }

    const winner = evaluation.matches[0];
    if (winner) {
      if (winner.binding.handling === 'delegate-dismiss') {
        return {
          kind: 'delegated',
          scopeId: winner.scope.id,
          bindingId: winner.binding.id,
        };
      }
      if (winner.binding.defaultBehavior === 'prevent') event.preventDefault();
      winner.binding.execute();
      return {
        kind: 'executed',
        scopeId: winner.scope.id,
        bindingId: winner.binding.id,
      };
    }

    if (evaluation.blockers.length > 0) {
      return {
        kind: 'blocked',
        layer,
        scopeIds: evaluation.blockers.map((scope) => scope.id),
      };
    }
    return null;
  };

  return {
    registerScope(scope) {
      const token = Symbol(scope.id);
      let record = state.scopes.get(scope.id);
      if (record && !sameScopeMetadata(record, scope)) {
        throw new Error(`Shortcut scope ${scope.id} was registered with conflicting metadata`);
      }
      if (!record) {
        const pendingBindings = state.pendingBindings.get(scope.id) ?? new Map();
        state.pendingBindings.delete(scope.id);
        record = {
          id: scope.id,
          layer: scope.layer,
          parentScopeId: scope.parentScopeId,
          blocksLowerLayers: scope.blocksLowerLayers,
          sequence: ++state.sequence,
          definitions: new Map(),
          bindings: pendingBindings,
        };
        state.scopes.set(scope.id, record);
      }
      record.definitions.set(token, { bindings: scope.bindings });
      const ownedRecord = record;
      let disposed = false;

      return () => {
        if (disposed || state.scopes.get(scope.id) !== ownedRecord) return;
        disposed = true;
        ownedRecord.definitions.delete(token);
        if (ownedRecord.definitions.size === 0) removeScopeTree(state, scope.id);
      };
    },

    registerBinding(scopeId, binding) {
      const record = state.scopes.get(scopeId);
      const token = Symbol(binding.id);
      const bindings = record?.bindings
        ?? state.pendingBindings.get(scopeId)
        ?? new Map<symbol, ShortcutBinding>();
      if (!record && !state.pendingBindings.has(scopeId)) {
        state.pendingBindings.set(scopeId, bindings);
      }
      bindings.set(token, binding);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        bindings.delete(token);
        if (bindings.size === 0 && state.pendingBindings.get(scopeId) === bindings) {
          state.pendingBindings.delete(scopeId);
        }
      };
    },

    activateFocusedScope(scopeId) {
      state.focusedScopeId = scopeId;
    },

    activateOwnerScope(scopeId) {
      state.ownerScopeId = scopeId;
    },

    getFocusedScope() {
      return state.focusedScopeId;
    },

    getOwnerScope() {
      return state.ownerScopeId;
    },

    hasActiveOverlay() {
      return Array.from(state.scopes.values()).some((scope) => scope.layer === 'overlay');
    },

    dispatch(event) {
      if (event.defaultPrevented) return { kind: 'ignored', reason: 'default-prevented' };
      if (event.isComposing) return { kind: 'ignored', reason: 'composing' };

      const combo = physicalCombo(event);
      const legacyCombo = legacyModCombo(event);
      for (const overlay of orderedOverlayScopes(state.scopes)) {
        const result = finishPosition(
          'overlay',
          evaluatePosition([overlay], event, combo, legacyCombo),
          combo,
          event,
        );
        if (result) return result;
      }

      for (const layer of FIXED_SHORTCUT_LAYERS) {
        let scopes = Array.from(state.scopes.values()).filter((scope) => scope.layer === layer);
        if (layer === 'active-primary-action') {
          scopes = scopes.filter((scope) => scope.id === state.ownerScopeId);
        } else if (layer === 'focused-control-fallback') {
          scopes = scopes.filter((scope) => scope.id === state.focusedScopeId);
        }
        const result = finishPosition(
          layer,
          evaluatePosition(scopes, event, combo, legacyCombo),
          combo,
          event,
        );
        if (result) return result;
      }

      return { kind: 'no-op' };
    },

    reset() {
      state.scopes.clear();
      state.pendingBindings.clear();
      state.focusedScopeId = null;
      state.ownerScopeId = null;
      state.sequence = 0;
    },
  };
}

export function createShortcutRouter(options: CreateShortcutRouterOptions = {}): ShortcutRouter {
  return createRouter(createRegistryState(), options.onConflict ?? defaultConflictReporter);
}

const globalHost = globalThis as Record<string, unknown>;
const applicationRegistry =
  (globalHost[REGISTRY_KEY] as ShortcutRegistryState | undefined)
  ?? (globalHost[REGISTRY_KEY] = createRegistryState()) as ShortcutRegistryState;
if (!applicationRegistry.pendingBindings) {
  Object.assign(applicationRegistry, { pendingBindings: new Map<string, Map<symbol, ShortcutBinding>>() });
}

export const applicationShortcutRouter = createRouter(applicationRegistry, defaultConflictReporter);

export const registerShortcutScope = applicationShortcutRouter.registerScope;
export const registerShortcutBinding = applicationShortcutRouter.registerBinding;
export const activateFocusedShortcutScope = applicationShortcutRouter.activateFocusedScope;
export const activateShortcutOwner = applicationShortcutRouter.activateOwnerScope;
export const getFocusedShortcutScope = applicationShortcutRouter.getFocusedScope;
export const getShortcutOwner = applicationShortcutRouter.getOwnerScope;
export const dispatchShortcutEvent = applicationShortcutRouter.dispatch;
export const resetShortcutRegistry = applicationShortcutRouter.reset;
