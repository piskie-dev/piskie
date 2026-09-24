export type ShortcutLayer =
  | 'overlay'
  | 'exclusive-input'
  | 'mode-transient'
  | 'active-primary-action'
  | 'focused-control-fallback'
  | 'mode-navigation'
  | 'page'
  | 'application';

export const FIXED_SHORTCUT_LAYERS = [
  'exclusive-input',
  'mode-transient',
  'active-primary-action',
  'focused-control-fallback',
  'mode-navigation',
  'page',
  'application',
] as const satisfies readonly Exclude<ShortcutLayer, 'overlay'>[];

export interface ShortcutBindingBase {
  readonly id: string;
  readonly commandId: string;
  /** A concrete canonical combo, for example `ctrl+b`, `meta+\\`, or `escape`. */
  readonly combo: string;
  readonly enabled: () => boolean;
  readonly allowInEditable?: boolean;
  /** Repeated keydown events are ignored unless this is explicitly true. */
  readonly repeat?: boolean;
}

export type ShortcutBinding =
  | (ShortcutBindingBase & {
      readonly handling: 'execute';
      readonly defaultBehavior: 'prevent' | 'preserve';
      readonly execute: () => void;
    })
  | (ShortcutBindingBase & {
      readonly handling: 'delegate-dismiss';
      readonly defaultBehavior: 'preserve';
    });

export interface ShortcutScope {
  readonly id: string;
  readonly layer: ShortcutLayer;
  readonly parentScopeId?: string;
  readonly blocksLowerLayers: 'none' | 'all';
  readonly bindings: readonly ShortcutBinding[];
}

/** DOM-independent keydown input consumed by the router. */
export interface ShortcutKeyEvent {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly editableTarget?: boolean;
  readonly repeat?: boolean;
  readonly preventDefault: () => void;
}

export type ShortcutIgnoredReason = 'default-prevented' | 'composing';

export interface ShortcutConflict {
  readonly combo: string;
  readonly layer: ShortcutLayer;
  readonly scopeIds: readonly string[];
  readonly bindingIds: readonly string[];
}

export type ShortcutDispatchResult =
  | { readonly kind: 'executed'; readonly scopeId: string; readonly bindingId: string }
  | { readonly kind: 'delegated'; readonly scopeId: string; readonly bindingId: string }
  | { readonly kind: 'blocked'; readonly layer: ShortcutLayer; readonly scopeIds: readonly string[] }
  | ({ readonly kind: 'conflict' } & ShortcutConflict)
  | { readonly kind: 'ignored'; readonly reason: ShortcutIgnoredReason }
  | { readonly kind: 'no-op' };
