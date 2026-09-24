/** Registers the Console page binding; App owns the application keydown listener. */

import { useEffect, useMemo, useRef } from 'react';

import { useShortcutScope, type ShortcutScope } from '@/shortcuts';
import { useEffectiveConsoleShortcut } from '../data/shortcuts';

export interface ConsoleKeyboardOptions {
  readonly toggleModeEnabled: boolean;
  readonly onToggleMode: () => void;
}

export function useConsoleKeyboard({ toggleModeEnabled, onToggleMode }: ConsoleKeyboardOptions): void {
  const shortcut = useEffectiveConsoleShortcut('console.toggleLayout');
  const latestToggle = useRef(onToggleMode);
  useEffect(() => {
    latestToggle.current = onToggleMode;
  }, [onToggleMode]);
  const scope = useMemo<ShortcutScope>(() => ({
    id: 'console-page',
    layer: 'page',
    blocksLowerLayers: 'none',
    bindings: shortcut ? [{
      id: 'console-page:toggle-layout',
      commandId: 'console.toggleLayout',
      combo: shortcut.physicalCombo,
      enabled: () => true,
      allowInEditable: true,
      handling: 'execute',
      defaultBehavior: 'prevent',
      execute: () => latestToggle.current(),
    }] : [],
  }), [shortcut]);
  useShortcutScope(scope, toggleModeEnabled && shortcut !== null);
}
