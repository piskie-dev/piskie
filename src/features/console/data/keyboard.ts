import {
  activateFocusedShortcutScope,
  applicationShortcutRouter,
  mountShortcutListener,
  registerShortcutScope,
  resetShortcutRegistry,
} from '../../../shortcuts';

export * from '../../../shortcuts';

export interface KeyBinding {
  /** Legacy `mod` accepts either Command or Control. New bindings use concrete combos. */
  readonly combo: string;
  readonly run: () => void;
  readonly description?: string;
}

export interface KeyEventLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly editableTarget?: boolean;
  readonly repeat?: boolean;
  readonly preventDefault?: () => void;
}

interface LegacyRegistryState {
  nextGlobalScopeId: number;
}

const LEGACY_REGISTRY_KEY = '__consoleKeyboardCompatibilityRegistryV1';
const globalHost = globalThis as Record<string, unknown>;
const legacyState =
  (globalHost[LEGACY_REGISTRY_KEY] as LegacyRegistryState | undefined)
  ?? (globalHost[LEGACY_REGISTRY_KEY] = { nextGlobalScopeId: 0 }) as LegacyRegistryState;

/** Compatibility normalizer retained for existing Console tests and action data. */
export function normalizeCombo(event: KeyEventLike): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(event.key.toLowerCase());
  return parts.join('+');
}

function allowsEditable(combo: string): boolean {
  const tokens = combo.toLowerCase().split('+');
  const key = tokens.at(-1);
  return key === 'escape'
    || tokens.slice(0, -1).some((token) => token === 'mod'
      || token === 'ctrl'
      || token === 'meta'
      || token === 'alt');
}

function toShortcutBinding(scopeId: string, binding: KeyBinding, index: number) {
  return {
    id: `${scopeId}:binding:${index}:${binding.combo}`,
    commandId: binding.description ?? `${scopeId}:${binding.combo}`,
    combo: binding.combo,
    enabled: () => true,
    allowInEditable: allowsEditable(binding.combo),
    repeat: false,
    handling: 'execute' as const,
    defaultBehavior: 'prevent' as const,
    execute: binding.run,
  };
}

/** Dispatches through the application router while preserving the legacy boolean result. */
export function dispatchKeyEvent(event: KeyEventLike): boolean {
  const result = applicationShortcutRouter.dispatch({
    ...event,
    preventDefault: event.preventDefault ?? (() => undefined),
  });
  return result.kind === 'executed' || result.kind === 'delegated';
}

/** Registers a legacy focus-owned panel at the focused-control fallback layer. */
export function registerScope(id: string, bindings: readonly KeyBinding[]): () => void {
  const scopeId = `legacy-focused:${id}`;
  return registerShortcutScope({
    id: scopeId,
    layer: 'focused-control-fallback',
    blocksLowerLayers: 'none',
    bindings: bindings.map((binding, index) => toShortcutBinding(scopeId, binding, index)),
  });
}

/** Registers a legacy global binding at the page layer. */
export function registerGlobalBinding(binding: KeyBinding): () => void {
  const scopeId = `legacy-page:${++legacyState.nextGlobalScopeId}`;
  return registerShortcutScope({
    id: scopeId,
    layer: 'page',
    blocksLowerLayers: 'none',
    bindings: [toShortcutBinding(scopeId, binding, 0)],
  });
}

export function focusScope(id: string | null): void {
  activateFocusedShortcutScope(id === null ? null : `legacy-focused:${id}`);
}

export function getFocusedScope(): string | null {
  const scopeId = applicationShortcutRouter.getFocusedScope();
  return scopeId?.startsWith('legacy-focused:') ? scopeId.slice('legacy-focused:'.length) : null;
}

export function resetKeyboardRegistry(): void {
  resetShortcutRegistry();
}

export const attachKeyboardListener = mountShortcutListener;
