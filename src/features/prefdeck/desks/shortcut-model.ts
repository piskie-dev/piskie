import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_CATALOG,
  normalizeShortcutEvent,
  normalizeShortcutPlatform,
  validateConfigurableShortcutCombo,
  validateShortcutOverrides,
  type ConfigurableShortcutCommandId,
  type ShortcutEventLike,
  type ShortcutOverrideValidationCode,
  type ShortcutOverrides,
} from '@shared/shortcuts';

const MODIFIER_KEYS = new Set([
  'alt',
  'altgraph',
  'cmd',
  'command',
  'control',
  'ctrl',
  'meta',
  'os',
  'option',
  'shift',
]);

export interface ShortcutDraftIssue {
  readonly code: ShortcutOverrideValidationCode;
  readonly conflictingCommandId?: ConfigurableShortcutCommandId;
}

export type ShortcutDraftValidation =
  | { readonly valid: true; readonly override: string }
  | { readonly valid: false; readonly issue: ShortcutDraftIssue };

export type ShortcutCaptureResult =
  | { readonly kind: 'modifier'; readonly preview: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'combo'; readonly combo: string };

export function shortcutCaptureResult(
  event: ShortcutEventLike,
  platform: string,
): ShortcutCaptureResult {
  if (isModifierOnlyShortcutEvent(event)) {
    return { kind: 'modifier', preview: formatModifierPreview(event, platform) };
  }
  const combo = normalizeShortcutEvent(event, platform);
  return combo ? { kind: 'combo', combo } : { kind: 'invalid' };
}

export function validateShortcutDraft(
  commandId: ConfigurableShortcutCommandId,
  combo: string,
  current: Readonly<ShortcutOverrides>,
  platform: string,
): ShortcutDraftValidation {
  const comboValidation = validateConfigurableShortcutCombo(combo, platform);
  if (!comboValidation.valid) {
    return { valid: false, issue: { code: comboValidation.code } };
  }

  const overrides: ShortcutOverrides = { ...current };
  if (combo === DEFAULT_SHORTCUTS[commandId]) delete overrides[commandId];
  else overrides[commandId] = combo;

  const conflict = validateShortcutOverrides(overrides, platform).find((issue) => (
    issue.code === 'physical-conflict'
      && (issue.commandId === commandId || issue.conflictingCommandId === commandId)
  ));
  if (conflict) {
    const conflictingCommandId = conflict.commandId === commandId
      ? conflict.conflictingCommandId
      : conflict.commandId;
    return {
      valid: false,
      issue: {
        code: conflict.code,
        ...(conflictingCommandId && { conflictingCommandId }),
      },
    };
  }

  return { valid: true, override: combo };
}

export function shortcutCommandNameKey(commandId: ConfigurableShortcutCommandId): string {
  return SHORTCUT_CATALOG[commandId].nameKey;
}

function isModifierOnlyShortcutEvent(event: ShortcutEventLike): boolean {
  return MODIFIER_KEYS.has(event.key.trim().toLowerCase());
}

function formatModifierPreview(event: ShortcutEventLike, platform: string): string {
  const target = normalizeShortcutPlatform(platform);
  const key = event.key.trim().toLowerCase();
  const ctrl = Boolean(
    event.ctrlKey || event.control || event.ctrl || key === 'control' || key === 'ctrl',
  );
  const meta = Boolean(
    event.metaKey || event.meta || ['cmd', 'command', 'meta', 'os'].includes(key),
  );
  const alt = Boolean(
    event.altKey || event.alt || key === 'alt' || key === 'altgraph' || key === 'option',
  );
  const shift = Boolean(event.shiftKey || event.shift || key === 'shift');
  const modifiers: string[] = [];

  if (target === 'darwin') {
    if (meta) modifiers.push('\u2318');
    if (ctrl) modifiers.push('\u2303');
    if (alt) modifiers.push('\u2325');
    if (shift) modifiers.push('\u21E7');
    return modifiers.join('');
  }

  if (ctrl) modifiers.push('Ctrl');
  if (meta) modifiers.push(target === 'win32' ? 'Win' : 'Meta');
  if (alt) modifiers.push('Alt');
  if (shift) modifiers.push('Shift');
  return modifiers.join('+');
}
