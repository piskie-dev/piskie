export type ComposerPendingAction = 'send' | 'interrupt' | null;

export interface ComposerMainAction {
  readonly kind: 'send' | 'sending' | 'interrupt';
  readonly disabled: boolean;
}

export function resolveComposerMainAction(
  hasContent: boolean,
  canPause: boolean,
  stopping: boolean,
  pendingAction: ComposerPendingAction,
): ComposerMainAction {
  if (pendingAction === 'send') return { kind: 'sending', disabled: true };
  if (pendingAction === 'interrupt' || stopping) return { kind: 'interrupt', disabled: true };
  if (canPause) return { kind: 'interrupt', disabled: false };
  return { kind: 'send', disabled: !hasContent };
}
