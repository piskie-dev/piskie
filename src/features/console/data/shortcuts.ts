import { useMemo } from 'react';

import {
  effectiveShortcut,
  expandPrimaryShortcut,
  formatShortcutAria,
  formatShortcutVisual,
  normalizeShortcutPlatform,
  type ConfigurableShortcutCommandId,
  type PhysicalShortcut,
  type ShortcutOverrides,
  type ShortcutPlatform,
} from '@shared/shortcuts';
import { useUIStore } from '@/store';

const EMPTY_OVERRIDES: Readonly<ShortcutOverrides> = Object.freeze({});

export interface EffectiveConsoleShortcut {
  readonly canonical: string;
  readonly physicalCombo: string;
  readonly display: string;
  readonly aria: string;
  readonly platform: ShortcutPlatform;
}

export function physicalShortcutCombo(shortcut: PhysicalShortcut): string {
  const tokens: string[] = [];
  if (shortcut.ctrl) tokens.push('ctrl');
  if (shortcut.meta) tokens.push('meta');
  if (shortcut.alt) tokens.push('alt');
  if (shortcut.shift) tokens.push('shift');
  tokens.push(shortcut.key);
  return tokens.join('+');
}

export function resolveEffectiveConsoleShortcut(
  commandId: ConfigurableShortcutCommandId,
  overrides: Readonly<ShortcutOverrides>,
  platform: string,
): EffectiveConsoleShortcut | null {
  const canonical = effectiveShortcut(commandId, overrides);
  if (canonical === null) return null;
  const normalizedPlatform = normalizeShortcutPlatform(platform);
  return {
    canonical,
    physicalCombo: physicalShortcutCombo(expandPrimaryShortcut(canonical, normalizedPlatform)),
    display: formatShortcutVisual(canonical, normalizedPlatform),
    aria: formatShortcutAria(canonical, normalizedPlatform),
    platform: normalizedPlatform,
  };
}

export function useEffectiveConsoleShortcut(
  commandId: ConfigurableShortcutCommandId,
): EffectiveConsoleShortcut | null {
  const overrides = useUIStore((state) => state.settings?.shortcuts);
  const platform = typeof window === 'undefined'
    ? 'linux'
    : window.piskie?.desktop?.system?.platform ?? 'linux';
  return useMemo(
    () => resolveEffectiveConsoleShortcut(commandId, overrides ?? EMPTY_OVERRIDES, platform),
    [commandId, overrides, platform],
  );
}
