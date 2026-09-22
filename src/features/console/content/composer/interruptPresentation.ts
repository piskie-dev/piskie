import type { ActionTarget } from '../../data/actions';
import type { EffectiveConsoleShortcut } from '../../data/shortcuts';
import type { ComposerMainAction } from './composerMainAction';

export interface InterruptPresentation {
  readonly enabled: boolean;
  readonly isShortcutOwner: boolean;
  readonly target: ActionTarget;
  readonly shortcut: EffectiveConsoleShortcut | null;
  readonly displayShortcut: string | null;
  readonly ariaShortcut: string | null;
}

export function resolveInterruptPresentation(
  target: ActionTarget,
  mainAction: ComposerMainAction,
  isShortcutOwner: boolean,
  effectiveShortcut: EffectiveConsoleShortcut | null,
): InterruptPresentation {
  const enabled = mainAction.kind === 'interrupt' && !mainAction.disabled;
  const shortcut = enabled && isShortcutOwner ? effectiveShortcut : null;
  return {
    enabled,
    isShortcutOwner,
    target,
    shortcut,
    displayShortcut: shortcut?.display ?? null,
    ariaShortcut: shortcut?.aria ?? null,
  };
}
