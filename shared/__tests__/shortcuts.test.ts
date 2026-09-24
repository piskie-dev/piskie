import { describe, expect, it } from 'vitest';

import {
  CONFIGURABLE_SHORTCUT_COMMAND_IDS,
  DEFAULT_SHORTCUTS,
  FIXED_SHORTCUT_COMMAND_IDS,
  RESERVED_SHORTCUT_COMMAND_IDS,
  SHORTCUT_CATALOG,
  expandPrimaryShortcut,
  formatShortcutAria,
  formatShortcutVisual,
  isElectronReservedShortcut,
  isTextEditingReservedShortcut,
  matchesShortcut,
  normalizeShortcutCombo,
  normalizeShortcutEvent,
  parseShortcutCombo,
  shortcutCombosConflict,
  shortcutCommandsCanConflict,
  tryParseShortcutCombo,
  validateConfigurableShortcutCombo,
  validateShortcutOverrides,
} from '../shortcuts.js';

describe('shortcut catalog', () => {
  it('exposes stable configurable defaults and fixed interaction metadata', () => {
    expect(CONFIGURABLE_SHORTCUT_COMMAND_IDS).toEqual([
      'agent.interruptCurrent',
      'console.toggleLayout',
      'tool.promoteToBackground',
    ]);
    expect(DEFAULT_SHORTCUTS).toEqual({
      'agent.interruptCurrent': 'escape',
      'console.toggleLayout': 'primary+\\',
      'tool.promoteToBackground': 'primary+b',
    });
    expect(FIXED_SHORTCUT_COMMAND_IDS).toContain('ui.dismissCurrentLayer');
    expect(SHORTCUT_CATALOG['ui.dismissCurrentLayer']).toMatchObject({
      configurable: false,
      defaultCombos: ['escape'],
      scope: 'overlay-or-navigation',
    });
    expect(RESERVED_SHORTCUT_COMMAND_IDS).toEqual([
      'system.reload',
      'system.find',
      'system.findNext',
      'system.print',
      'system.developerTools',
    ]);
    expect(SHORTCUT_CATALOG['system.developerTools']).toMatchObject({
      configurable: false,
      reserved: true,
      defaultCombos: ['primary+shift+i', 'f12'],
      scope: 'application-window',
    });
  });
});

describe('shortcut combo parsing', () => {
  it('normalizes aliases, modifier order, and key casing', () => {
    expect(parseShortcutCombo('Shift+PRIMARY+B')).toEqual({
      canonical: 'primary+shift+b',
      modifiers: ['primary', 'shift'],
      key: 'b',
    });
    expect(normalizeShortcutCombo('Control+Alt+X')).toBe('ctrl+alt+x');
    expect(normalizeShortcutCombo('mod+\\')).toBe('primary+\\');
    expect(normalizeShortcutCombo('Esc')).toBe('escape');
  });

  it('rejects malformed chords and modifier-only input', () => {
    expect(tryParseShortcutCombo('')).toBeNull();
    expect(tryParseShortcutCombo('primary++b')).toBeNull();
    expect(tryParseShortcutCombo('ctrl+control+b')).toBeNull();
    expect(tryParseShortcutCombo('primary+b+x')).toBeNull();
    expect(tryParseShortcutCombo('shift')).toBeNull();
    expect(tryParseShortcutCombo('primary+NotAKeyboardKey')).toBeNull();
  });
});

describe('shortcut physical expansion and matching', () => {
  it('expands primary per platform while preserving explicit modifiers', () => {
    expect(expandPrimaryShortcut('primary+b', 'darwin')).toMatchObject({
      ctrl: false,
      meta: true,
      key: 'b',
    });
    expect(expandPrimaryShortcut('primary+b', 'win32')).toMatchObject({
      ctrl: true,
      meta: false,
      key: 'b',
    });
    expect(expandPrimaryShortcut('meta+b', 'linux')).toMatchObject({
      ctrl: false,
      meta: true,
      key: 'b',
    });
  });

  it('matches exact KeyboardEvent-like physical chords', () => {
    expect(matchesShortcut({ key: 'B', metaKey: true }, 'primary+b', 'darwin')).toBe(true);
    expect(matchesShortcut({ key: 'b', ctrlKey: true }, 'primary+b', 'win32')).toBe(true);
    expect(matchesShortcut({ key: 'b', metaKey: true }, 'primary+b', 'win32')).toBe(false);
    expect(matchesShortcut(
      { key: 'b', ctrlKey: true, shiftKey: true },
      'primary+b',
      'linux',
    )).toBe(false);
  });

  it('normalizes captured events using platform primary semantics', () => {
    expect(normalizeShortcutEvent({ key: 'B', metaKey: true }, 'darwin'))
      .toBe('primary+b');
    expect(normalizeShortcutEvent({ key: 'b', ctrlKey: true }, 'darwin'))
      .toBe('ctrl+b');
    expect(normalizeShortcutEvent({ key: 'b', ctrlKey: true }, 'win32'))
      .toBe('primary+b');
    expect(normalizeShortcutEvent({ key: 'b', metaKey: true }, 'linux'))
      .toBe('meta+b');
    expect(normalizeShortcutEvent({ key: 'Control', ctrlKey: true }, 'linux')).toBeNull();
  });

  it('detects alias-equivalent physical conflicts', () => {
    expect(shortcutCombosConflict('primary+b', 'meta+b', 'darwin')).toBe(true);
    expect(shortcutCombosConflict('primary+b', 'ctrl+b', 'win32')).toBe(true);
    expect(shortcutCombosConflict('primary+b', 'ctrl+b', 'linux')).toBe(true);
    expect(shortcutCombosConflict('primary+b', 'meta+b', 'linux')).toBe(false);
  });
});

describe('shortcut formatting', () => {
  it('uses platform visual conventions separately from ARIA tokens', () => {
    expect(formatShortcutVisual('escape', 'darwin')).toBe('Esc');
    expect(formatShortcutVisual('primary+\\', 'darwin')).toBe('\u2318\\');
    expect(formatShortcutVisual('primary+shift+x', 'darwin')).toBe('\u2318\u21E7X');
    expect(formatShortcutVisual('primary+shift+x', 'win32')).toBe('Ctrl+Shift+X');
    expect(formatShortcutVisual('primary+b', 'linux')).toBe('Ctrl+B');
    expect(formatShortcutVisual('meta+x', 'win32')).toBe('Win+X');
    expect(formatShortcutVisual('meta+x', 'linux')).toBe('Meta+X');

    expect(formatShortcutAria('escape', 'darwin')).toBe('Escape');
    expect(formatShortcutAria('primary+shift+x', 'darwin')).toBe('Meta+Shift+X');
    expect(formatShortcutAria('primary+shift+x', 'linux')).toBe('Control+Shift+X');
    expect(formatShortcutAria('primary+plus', 'linux')).toBe('Control+plus');
  });
});

describe('shortcut reservation and configuration validation', () => {
  it('matches Electron reserved chords with the same extra-modifier behavior', () => {
    expect(isElectronReservedShortcut(
      { key: 'R', control: true, shift: true, alt: true },
      'linux',
      true,
    )).toBe(true);
    expect(isElectronReservedShortcut(
      { key: 'g', meta: true, alt: true },
      'darwin',
      true,
    )).toBe(true);
    expect(isElectronReservedShortcut(
      { key: 'i', control: true, shift: true, alt: true },
      'win32',
      false,
    )).toBe(true);
    expect(isElectronReservedShortcut(
      { key: 'F12', meta: true, alt: true },
      'darwin',
      false,
    )).toBe(true);
    expect(isElectronReservedShortcut({ key: 'F12' }, 'linux', true)).toBe(false);
    expect(isElectronReservedShortcut(
      { key: 'i', control: true, shift: true },
      'linux',
      true,
    )).toBe(false);
  });

  it('uses the closed platform text-editing reservation matrix', () => {
    expect(isTextEditingReservedShortcut('primary+c', 'darwin')).toBe(true);
    expect(isTextEditingReservedShortcut('meta+c', 'darwin')).toBe(true);
    expect(isTextEditingReservedShortcut('ctrl+c', 'darwin')).toBe(false);
    expect(isTextEditingReservedShortcut('primary+insert', 'win32')).toBe(true);
    expect(isTextEditingReservedShortcut('primary+shift+z', 'linux')).toBe(true);
    expect(isTextEditingReservedShortcut('primary+shift+y', 'linux')).toBe(false);
  });

  it('accepts only canonical configurable chords outside reserved sets', () => {
    expect(validateConfigurableShortcutCombo('escape', 'linux').valid).toBe(true);
    expect(validateConfigurableShortcutCombo('primary+shift+x', 'linux').valid).toBe(true);
    expect(validateConfigurableShortcutCombo('b', 'linux')).toMatchObject({
      valid: false,
      code: 'missing-modifier',
    });
    expect(validateConfigurableShortcutCombo('shift+x', 'linux')).toMatchObject({
      valid: false,
      code: 'missing-modifier',
    });
    expect(validateConfigurableShortcutCombo('primary+enter', 'linux')).toMatchObject({
      valid: false,
      code: 'fixed-control-combo',
    });
    expect(validateConfigurableShortcutCombo('PRIMARY+x', 'linux')).toMatchObject({
      valid: false,
      code: 'non-canonical-combo',
    });
    expect(validateConfigurableShortcutCombo('primary+c', 'linux')).toMatchObject({
      valid: false,
      code: 'editor-reserved-combo',
    });
    expect(validateConfigurableShortcutCombo('primary+r', 'linux')).toMatchObject({
      valid: false,
      code: 'electron-reserved-combo',
    });
    expect(validateConfigurableShortcutCombo('f12', 'linux')).toMatchObject({
      valid: false,
      code: 'electron-reserved-combo',
    });
  });

  it('rejects reachable physical conflicts while allowing fixed contextual overlap', () => {
    expect(validateShortcutOverrides({
      'console.toggleLayout': 'ctrl+b',
    }, 'linux')).toContainEqual(expect.objectContaining({
      code: 'physical-conflict',
      commandId: 'console.toggleLayout',
      conflictingCommandId: 'tool.promoteToBackground',
    }));
    expect(validateShortcutOverrides({
      'agent.interruptCurrent': null,
      'console.toggleLayout': 'primary+shift+l',
    }, 'linux')).toEqual([]);
    expect(shortcutCommandsCanConflict(
      'agent.interruptCurrent',
      'tool.promoteToBackground',
    )).toBe(true);
    expect(shortcutCommandsCanConflict(
      'agent.interruptCurrent',
      'ui.dismissCurrentLayer',
    )).toBe(false);
  });
});
