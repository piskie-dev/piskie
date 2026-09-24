export const CONFIGURABLE_SHORTCUT_COMMAND_IDS = [
  'agent.interruptCurrent',
  'console.toggleLayout',
  'tool.promoteToBackground',
] as const;

export const FIXED_SHORTCUT_COMMAND_IDS = [
  'ui.dismissCurrentLayer',
  'composer.submit',
  'composer.insertLineBreak',
  'list.navigate',
  'control.activate',
  'image.navigate',
  'image.jumpBoundary',
  'focus.navigate',
] as const;

export const RESERVED_SHORTCUT_COMMAND_IDS = [
  'system.reload',
  'system.find',
  'system.findNext',
  'system.print',
  'system.developerTools',
] as const;

export type ConfigurableShortcutCommandId =
  (typeof CONFIGURABLE_SHORTCUT_COMMAND_IDS)[number];
export type FixedShortcutCommandId = (typeof FIXED_SHORTCUT_COMMAND_IDS)[number];
export type ReservedShortcutCommandId = (typeof RESERVED_SHORTCUT_COMMAND_IDS)[number];
export type ShortcutCommandId =
  | ConfigurableShortcutCommandId
  | FixedShortcutCommandId
  | ReservedShortcutCommandId;

export interface ShortcutOverrides {
  'agent.interruptCurrent'?: string | null;
  'console.toggleLayout'?: string | null;
  'tool.promoteToBackground'?: string | null;
}

export type ShortcutPlatform = 'darwin' | 'win32' | 'linux';
export type ShortcutModifier = 'primary' | 'ctrl' | 'meta' | 'alt' | 'shift';
export type ShortcutScope =
  | 'active-primary-owner'
  | 'console-page'
  | 'focused-console-panel'
  | 'overlay-or-navigation'
  | 'composer'
  | 'list'
  | 'control'
  | 'image'
  | 'browser-focus'
  | 'application-window';

interface ShortcutCatalogEntryBase {
  readonly id: ShortcutCommandId;
  readonly nameKey: string;
  readonly scopeKey: string;
  readonly scope: ShortcutScope;
  readonly defaultCombos: readonly string[];
}

export interface ConfigurableShortcutCatalogEntry extends ShortcutCatalogEntryBase {
  readonly id: ConfigurableShortcutCommandId;
  readonly configurable: true;
  readonly conflictContexts: readonly ['console'];
}

export interface FixedShortcutCatalogEntry extends ShortcutCatalogEntryBase {
  readonly id: FixedShortcutCommandId;
  readonly configurable: false;
}

export interface ReservedShortcutCatalogEntry extends ShortcutCatalogEntryBase {
  readonly id: ReservedShortcutCommandId;
  readonly configurable: false;
  readonly reserved: true;
}

export type ShortcutCatalogEntry =
  | ConfigurableShortcutCatalogEntry
  | FixedShortcutCatalogEntry
  | ReservedShortcutCatalogEntry;

export const DEFAULT_SHORTCUTS = Object.freeze({
  'agent.interruptCurrent': 'escape',
  'console.toggleLayout': 'primary+\\',
  'tool.promoteToBackground': 'primary+b',
} satisfies Record<ConfigurableShortcutCommandId, string>);

export const SHORTCUT_CATALOG = Object.freeze({
  'agent.interruptCurrent': {
    id: 'agent.interruptCurrent',
    configurable: true,
    nameKey: 'shortcuts.commands.agentInterruptCurrent',
    scopeKey: 'shortcuts.scopes.activePrimaryOwner',
    scope: 'active-primary-owner',
    defaultCombos: [DEFAULT_SHORTCUTS['agent.interruptCurrent']],
    conflictContexts: ['console'],
  },
  'console.toggleLayout': {
    id: 'console.toggleLayout',
    configurable: true,
    nameKey: 'shortcuts.commands.consoleToggleLayout',
    scopeKey: 'shortcuts.scopes.console',
    scope: 'console-page',
    defaultCombos: [DEFAULT_SHORTCUTS['console.toggleLayout']],
    conflictContexts: ['console'],
  },
  'tool.promoteToBackground': {
    id: 'tool.promoteToBackground',
    configurable: true,
    nameKey: 'shortcuts.commands.toolPromoteToBackground',
    scopeKey: 'shortcuts.scopes.focusedConsolePanel',
    scope: 'focused-console-panel',
    defaultCombos: [DEFAULT_SHORTCUTS['tool.promoteToBackground']],
    conflictContexts: ['console'],
  },
  'ui.dismissCurrentLayer': {
    id: 'ui.dismissCurrentLayer',
    configurable: false,
    nameKey: 'shortcuts.commands.uiDismissCurrentLayer',
    scopeKey: 'shortcuts.scopes.overlayOrNavigation',
    scope: 'overlay-or-navigation',
    defaultCombos: ['escape'],
  },
  'composer.submit': {
    id: 'composer.submit',
    configurable: false,
    nameKey: 'shortcuts.commands.composerSubmit',
    scopeKey: 'shortcuts.scopes.composer',
    scope: 'composer',
    defaultCombos: ['enter'],
  },
  'composer.insertLineBreak': {
    id: 'composer.insertLineBreak',
    configurable: false,
    nameKey: 'shortcuts.commands.composerInsertLineBreak',
    scopeKey: 'shortcuts.scopes.composer',
    scope: 'composer',
    defaultCombos: ['shift+enter'],
  },
  'list.navigate': {
    id: 'list.navigate',
    configurable: false,
    nameKey: 'shortcuts.commands.listNavigate',
    scopeKey: 'shortcuts.scopes.list',
    scope: 'list',
    defaultCombos: ['arrowup', 'arrowdown'],
  },
  'control.activate': {
    id: 'control.activate',
    configurable: false,
    nameKey: 'shortcuts.commands.controlActivate',
    scopeKey: 'shortcuts.scopes.control',
    scope: 'control',
    defaultCombos: ['enter', 'space'],
  },
  'image.navigate': {
    id: 'image.navigate',
    configurable: false,
    nameKey: 'shortcuts.commands.imageNavigate',
    scopeKey: 'shortcuts.scopes.image',
    scope: 'image',
    defaultCombos: ['arrowleft', 'arrowright'],
  },
  'image.jumpBoundary': {
    id: 'image.jumpBoundary',
    configurable: false,
    nameKey: 'shortcuts.commands.imageJumpBoundary',
    scopeKey: 'shortcuts.scopes.image',
    scope: 'image',
    defaultCombos: ['home', 'end'],
  },
  'focus.navigate': {
    id: 'focus.navigate',
    configurable: false,
    nameKey: 'shortcuts.commands.focusNavigate',
    scopeKey: 'shortcuts.scopes.browserFocus',
    scope: 'browser-focus',
    defaultCombos: ['tab'],
  },
  'system.reload': {
    id: 'system.reload',
    configurable: false,
    reserved: true,
    nameKey: 'shortcuts.commands.systemReload',
    scopeKey: 'shortcuts.scopes.applicationWindow',
    scope: 'application-window',
    defaultCombos: ['primary+r'],
  },
  'system.find': {
    id: 'system.find',
    configurable: false,
    reserved: true,
    nameKey: 'shortcuts.commands.systemFind',
    scopeKey: 'shortcuts.scopes.applicationWindow',
    scope: 'application-window',
    defaultCombos: ['primary+f'],
  },
  'system.findNext': {
    id: 'system.findNext',
    configurable: false,
    reserved: true,
    nameKey: 'shortcuts.commands.systemFindNext',
    scopeKey: 'shortcuts.scopes.applicationWindow',
    scope: 'application-window',
    defaultCombos: ['primary+g'],
  },
  'system.print': {
    id: 'system.print',
    configurable: false,
    reserved: true,
    nameKey: 'shortcuts.commands.systemPrint',
    scopeKey: 'shortcuts.scopes.applicationWindow',
    scope: 'application-window',
    defaultCombos: ['primary+p'],
  },
  'system.developerTools': {
    id: 'system.developerTools',
    configurable: false,
    reserved: true,
    nameKey: 'shortcuts.commands.systemDeveloperTools',
    scopeKey: 'shortcuts.scopes.applicationWindow',
    scope: 'application-window',
    defaultCombos: ['primary+shift+i', 'f12'],
  },
} as const satisfies Record<ShortcutCommandId, ShortcutCatalogEntry>);

export const SHORTCUT_CATALOG_ENTRIES = Object.freeze(
  Object.values(SHORTCUT_CATALOG) as readonly ShortcutCatalogEntry[],
);

export interface ParsedShortcutCombo {
  readonly canonical: string;
  readonly modifiers: readonly ShortcutModifier[];
  readonly key: string;
}

export interface PhysicalShortcut {
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface ShortcutEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly control?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

export type ShortcutParseErrorCode =
  | 'empty'
  | 'too-long'
  | 'empty-token'
  | 'duplicate-modifier'
  | 'multiple-keys'
  | 'missing-key'
  | 'invalid-key';

export class ShortcutParseError extends Error {
  constructor(
    readonly code: ShortcutParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShortcutParseError';
  }
}

const MODIFIER_ORDER: readonly ShortcutModifier[] = [
  'primary',
  'ctrl',
  'meta',
  'alt',
  'shift',
];

const MODIFIER_ALIASES: Readonly<Record<string, ShortcutModifier>> = Object.freeze({
  primary: 'primary',
  mod: 'primary',
  ctrl: 'ctrl',
  control: 'ctrl',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
});

const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  esc: 'escape',
  escape: 'escape',
  return: 'enter',
  enter: 'enter',
  spacebar: 'space',
  space: 'space',
  up: 'arrowup',
  arrowup: 'arrowup',
  down: 'arrowdown',
  arrowdown: 'arrowdown',
  left: 'arrowleft',
  arrowleft: 'arrowleft',
  right: 'arrowright',
  arrowright: 'arrowright',
  del: 'delete',
  delete: 'delete',
  backspace: 'backspace',
  home: 'home',
  end: 'end',
  insert: 'insert',
  tab: 'tab',
  pageup: 'pageup',
  pagedown: 'pagedown',
  plus: 'plus',
});

const FIXED_CONTROL_KEYS = new Set([
  'enter',
  'tab',
  'space',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'home',
  'end',
  'delete',
  'backspace',
]);

export function normalizeShortcutPlatform(platform: string): ShortcutPlatform {
  const normalized = platform.toLowerCase();
  if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos') {
    return 'darwin';
  }
  if (normalized === 'win32' || normalized === 'win' || normalized === 'windows') {
    return 'win32';
  }
  return 'linux';
}

export function parseShortcutCombo(input: string): ParsedShortcutCombo {
  if (input.length === 0) throw new ShortcutParseError('empty', 'Shortcut combo is empty.');
  if (input.length > 80) throw new ShortcutParseError('too-long', 'Shortcut combo is too long.');

  const rawTokens = input.split('+');
  if (rawTokens.some((token) => token.trim().length === 0)) {
    throw new ShortcutParseError('empty-token', 'Shortcut combo contains an empty token.');
  }

  const modifiers = new Set<ShortcutModifier>();
  let key: string | undefined;
  for (const rawToken of rawTokens) {
    const token = rawToken.trim().toLowerCase();
    const modifier = MODIFIER_ALIASES[token];
    if (modifier) {
      if (modifiers.has(modifier)) {
        throw new ShortcutParseError(
          'duplicate-modifier',
          `Shortcut combo contains duplicate modifier: ${modifier}.`,
        );
      }
      modifiers.add(modifier);
      continue;
    }
    if (key !== undefined) {
      throw new ShortcutParseError('multiple-keys', 'Shortcut combo contains multiple keys.');
    }
    key = normalizeShortcutKey(rawToken);
  }

  if (!key) throw new ShortcutParseError('missing-key', 'Shortcut combo is missing a key.');
  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return Object.freeze({
    canonical: [...orderedModifiers, key].join('+'),
    modifiers: Object.freeze(orderedModifiers),
    key,
  });
}

export function tryParseShortcutCombo(input: string): ParsedShortcutCombo | null {
  try {
    return parseShortcutCombo(input);
  } catch (error) {
    if (error instanceof ShortcutParseError) return null;
    throw error;
  }
}

export function normalizeShortcutCombo(input: string): string | null {
  return tryParseShortcutCombo(input)?.canonical ?? null;
}

export function normalizeShortcutKey(input: string): string {
  if (input === ' ') return 'space';
  if (input === '+') return 'plus';
  const normalized = input.trim().toLowerCase();
  const aliased = KEY_ALIASES[normalized];
  if (aliased) return aliased;
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(normalized)) return normalized;
  if ([...normalized].length === 1 && !/\s/u.test(normalized)) return normalized;
  throw new ShortcutParseError('invalid-key', `Shortcut combo contains invalid key: ${input}.`);
}

export function expandPrimaryShortcut(
  combo: string | ParsedShortcutCombo,
  platform: string,
): PhysicalShortcut {
  const parsed = typeof combo === 'string' ? parseShortcutCombo(combo) : combo;
  const target = normalizeShortcutPlatform(platform);
  const primary = target === 'darwin' ? 'meta' : 'ctrl';
  const modifiers = new Set(parsed.modifiers.map((modifier) => (
    modifier === 'primary' ? primary : modifier
  )));
  return Object.freeze({
    key: parsed.key,
    ctrl: modifiers.has('ctrl'),
    meta: modifiers.has('meta'),
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
  });
}

export function physicalShortcutFromEvent(event: ShortcutEventLike): PhysicalShortcut {
  return Object.freeze({
    key: normalizeShortcutKey(event.key),
    ctrl: Boolean(event.ctrlKey || event.control || event.ctrl),
    meta: Boolean(event.metaKey || event.meta),
    alt: Boolean(event.altKey || event.alt),
    shift: Boolean(event.shiftKey || event.shift),
  });
}

export function normalizeShortcutEvent(
  event: ShortcutEventLike,
  platform: string,
): string | null {
  if (MODIFIER_ALIASES[event.key.trim().toLowerCase()]) return null;
  let key: string;
  try {
    key = normalizeShortcutKey(event.key);
  } catch (error) {
    if (error instanceof ShortcutParseError) return null;
    throw error;
  }

  const target = normalizeShortcutPlatform(platform);
  const physical = {
    ctrl: Boolean(event.ctrlKey || event.control || event.ctrl),
    meta: Boolean(event.metaKey || event.meta),
    alt: Boolean(event.altKey || event.alt),
    shift: Boolean(event.shiftKey || event.shift),
  };
  const modifiers: ShortcutModifier[] = [];
  if (target === 'darwin' ? physical.meta : physical.ctrl) modifiers.push('primary');
  if (target === 'darwin' && physical.ctrl) modifiers.push('ctrl');
  if (target !== 'darwin' && physical.meta) modifiers.push('meta');
  if (physical.alt) modifiers.push('alt');
  if (physical.shift) modifiers.push('shift');
  return [...modifiers, key].join('+');
}

export function matchesShortcut(
  event: ShortcutEventLike,
  combo: string | ParsedShortcutCombo,
  platform: string,
): boolean {
  let actual: PhysicalShortcut;
  let expected: PhysicalShortcut;
  try {
    actual = physicalShortcutFromEvent(event);
    expected = expandPrimaryShortcut(combo, platform);
  } catch (error) {
    if (error instanceof ShortcutParseError) return false;
    throw error;
  }
  return physicalShortcutsEqual(actual, expected);
}

export function physicalShortcutsEqual(
  left: PhysicalShortcut,
  right: PhysicalShortcut,
): boolean {
  return left.key === right.key
    && left.ctrl === right.ctrl
    && left.meta === right.meta
    && left.alt === right.alt
    && left.shift === right.shift;
}

export function shortcutCombosConflict(
  left: string | ParsedShortcutCombo,
  right: string | ParsedShortcutCombo,
  platform: string,
): boolean {
  return physicalShortcutsEqual(
    expandPrimaryShortcut(left, platform),
    expandPrimaryShortcut(right, platform),
  );
}

export function formatShortcutVisual(
  combo: string | ParsedShortcutCombo,
  platform: string,
): string {
  const parsed = typeof combo === 'string' ? parseShortcutCombo(combo) : combo;
  const target = normalizeShortcutPlatform(platform);
  const modifiers = parsed.modifiers.map((modifier) => visualModifier(modifier, target));
  const key = visualKey(parsed.key);
  return target === 'darwin' ? `${modifiers.join('')}${key}` : [...modifiers, key].join('+');
}

export function formatShortcutAria(
  combo: string | ParsedShortcutCombo,
  platform: string,
): string {
  const parsed = typeof combo === 'string' ? parseShortcutCombo(combo) : combo;
  const target = normalizeShortcutPlatform(platform);
  return [
    ...parsed.modifiers.map((modifier) => ariaModifier(modifier, target)),
    ariaKey(parsed.key),
  ].join('+');
}

export function isTextEditingReservedShortcut(
  combo: string | ParsedShortcutCombo,
  platform: string,
): boolean {
  const physical = expandPrimaryShortcut(combo, platform);
  const target = normalizeShortcutPlatform(platform);
  const prefix = target === 'darwin' ? 'meta' : 'ctrl';
  const reserved = new Set([
    `${prefix}+a`,
    `${prefix}+c`,
    `${prefix}+x`,
    `${prefix}+v`,
    `${prefix}+z`,
    `${prefix}+y`,
    `${prefix}+shift+z`,
    ...(target === 'darwin' ? [] : [`${prefix}+insert`]),
  ]);
  return reserved.has(physicalShortcutId(physical));
}

export function isElectronReservedShortcut(
  input: ShortcutEventLike | PhysicalShortcut,
  platform: string,
  development: boolean,
): boolean {
  let physical: PhysicalShortcut;
  try {
    physical = isPhysicalShortcut(input) ? input : physicalShortcutFromEvent(input);
  } catch (error) {
    if (error instanceof ShortcutParseError) return false;
    throw error;
  }
  const target = normalizeShortcutPlatform(platform);
  const primary = target === 'darwin' ? physical.meta : physical.ctrl;
  if (primary && ['r', 'f', 'g', 'p'].includes(physical.key)) return true;
  if (!development && physical.key === 'f12') return true;
  return !development && primary && physical.shift && physical.key === 'i';
}

export type ShortcutComboValidationCode =
  | 'invalid-combo'
  | 'non-canonical-combo'
  | 'fixed-control-combo'
  | 'missing-modifier'
  | 'redundant-modifier'
  | 'editor-reserved-combo'
  | 'electron-reserved-combo';

export type ShortcutComboValidation =
  | { readonly valid: true; readonly combo: ParsedShortcutCombo }
  | {
      readonly valid: false;
      readonly code: ShortcutComboValidationCode;
      readonly message: string;
    };

export function validateConfigurableShortcutCombo(
  combo: string,
  platform: string,
): ShortcutComboValidation {
  const parsed = tryParseShortcutCombo(combo);
  if (!parsed) {
    return invalidCombo('invalid-combo', 'Shortcut combo is not valid.');
  }
  if (parsed.canonical !== combo) {
    return invalidCombo(
      'non-canonical-combo',
      `Shortcut combo must use canonical form: ${parsed.canonical}.`,
    );
  }
  if (FIXED_CONTROL_KEYS.has(parsed.key)) {
    return invalidCombo(
      'fixed-control-combo',
      'Shortcut combo uses a key reserved for fixed control behavior.',
    );
  }

  const target = normalizeShortcutPlatform(platform);
  if (parsed.key === 'f12'
    && isElectronReservedShortcut(expandPrimaryShortcut(parsed, target), target, false)) {
    return invalidCombo(
      'electron-reserved-combo',
      'Shortcut combo is reserved by the application window.',
    );
  }

  const isBareEscape = parsed.key === 'escape' && parsed.modifiers.length === 0;
  const hasCommandModifier = parsed.modifiers.some((modifier) => (
    modifier === 'primary' || modifier === 'ctrl' || modifier === 'meta' || modifier === 'alt'
  ));
  if (!isBareEscape && !hasCommandModifier) {
    return invalidCombo(
      'missing-modifier',
      'Shortcut combo must be Escape or include primary, ctrl, meta, or alt.',
    );
  }

  const aliasesPrimary = parsed.modifiers.includes('primary')
    && parsed.modifiers.includes(target === 'darwin' ? 'meta' : 'ctrl');
  if (aliasesPrimary) {
    return invalidCombo(
      'redundant-modifier',
      'Shortcut combo repeats the platform primary modifier.',
    );
  }
  if (isTextEditingReservedShortcut(parsed, target)) {
    return invalidCombo(
      'editor-reserved-combo',
      'Shortcut combo is reserved for text editing.',
    );
  }
  if (isElectronReservedShortcut(expandPrimaryShortcut(parsed, target), target, false)) {
    return invalidCombo(
      'electron-reserved-combo',
      'Shortcut combo is reserved by the application window.',
    );
  }
  return Object.freeze({ valid: true, combo: parsed });
}

export type ShortcutOverrideValidationCode = ShortcutComboValidationCode | 'physical-conflict';

export interface ShortcutOverrideValidationIssue {
  readonly code: ShortcutOverrideValidationCode;
  readonly commandId: ConfigurableShortcutCommandId;
  readonly conflictingCommandId?: ConfigurableShortcutCommandId;
  readonly message: string;
}

export function validateShortcutOverrides(
  overrides: Readonly<ShortcutOverrides>,
  platform: string,
): readonly ShortcutOverrideValidationIssue[] {
  const issues: ShortcutOverrideValidationIssue[] = [];
  const validBindings = new Map<ConfigurableShortcutCommandId, ParsedShortcutCombo>();

  for (const commandId of CONFIGURABLE_SHORTCUT_COMMAND_IDS) {
    const combo = effectiveShortcut(commandId, overrides);
    if (combo === null) continue;
    const validation = validateConfigurableShortcutCombo(combo, platform);
    if (!validation.valid) {
      issues.push({
        code: validation.code,
        commandId,
        message: validation.message,
      });
      continue;
    }
    validBindings.set(commandId, validation.combo);
  }

  for (let index = 0; index < CONFIGURABLE_SHORTCUT_COMMAND_IDS.length; index += 1) {
    const leftId = CONFIGURABLE_SHORTCUT_COMMAND_IDS[index];
    if (!leftId) continue;
    const left = validBindings.get(leftId);
    if (!left) continue;
    for (const rightId of CONFIGURABLE_SHORTCUT_COMMAND_IDS.slice(index + 1)) {
      const right = validBindings.get(rightId);
      if (!right || !shortcutCommandsCanConflict(leftId, rightId)) continue;
      if (!shortcutCombosConflict(left, right, platform)) continue;
      const reportLeft = overrides[leftId] !== undefined && overrides[rightId] === undefined;
      issues.push({
        code: 'physical-conflict',
        commandId: reportLeft ? leftId : rightId,
        conflictingCommandId: reportLeft ? rightId : leftId,
        message: `Shortcut conflicts with ${reportLeft ? rightId : leftId}.`,
      });
    }
  }

  return Object.freeze(issues);
}

export function effectiveShortcut(
  commandId: ConfigurableShortcutCommandId,
  overrides: Readonly<ShortcutOverrides>,
): string | null {
  const override = overrides[commandId];
  return override === undefined ? DEFAULT_SHORTCUTS[commandId] : override;
}

export function shortcutCommandsCanConflict(
  leftId: ShortcutCommandId,
  rightId: ShortcutCommandId,
): boolean {
  const left = SHORTCUT_CATALOG[leftId];
  const right = SHORTCUT_CATALOG[rightId];
  if (!left.configurable || !right.configurable) return false;
  return left.conflictContexts.some((context) => right.conflictContexts.includes(context));
}

function invalidCombo(
  code: ShortcutComboValidationCode,
  message: string,
): ShortcutComboValidation {
  return Object.freeze({ valid: false, code, message });
}

function isPhysicalShortcut(
  input: ShortcutEventLike | PhysicalShortcut,
): input is PhysicalShortcut {
  return 'ctrl' in input
    && typeof input.ctrl === 'boolean'
    && 'meta' in input
    && typeof input.meta === 'boolean'
    && 'alt' in input
    && typeof input.alt === 'boolean'
    && 'shift' in input
    && typeof input.shift === 'boolean';
}

function physicalShortcutId(shortcut: PhysicalShortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrl) parts.push('ctrl');
  if (shortcut.meta) parts.push('meta');
  if (shortcut.alt) parts.push('alt');
  if (shortcut.shift) parts.push('shift');
  parts.push(shortcut.key);
  return parts.join('+');
}

function visualModifier(modifier: ShortcutModifier, platform: ShortcutPlatform): string {
  if (platform === 'darwin') {
    return {
      primary: '\u2318',
      ctrl: '\u2303',
      meta: '\u2318',
      alt: '\u2325',
      shift: '\u21E7',
    }[modifier];
  }
  if (modifier === 'primary' || modifier === 'ctrl') return 'Ctrl';
  if (modifier === 'meta') return platform === 'win32' ? 'Win' : 'Meta';
  if (modifier === 'alt') return 'Alt';
  return 'Shift';
}

function ariaModifier(modifier: ShortcutModifier, platform: ShortcutPlatform): string {
  if (modifier === 'primary') return platform === 'darwin' ? 'Meta' : 'Control';
  if (modifier === 'ctrl') return 'Control';
  if (modifier === 'meta') return 'Meta';
  if (modifier === 'alt') return 'Alt';
  return 'Shift';
}

function visualKey(key: string): string {
  const names: Readonly<Record<string, string>> = {
    escape: 'Esc',
    enter: 'Enter',
    tab: 'Tab',
    space: 'Space',
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    home: 'Home',
    end: 'End',
    delete: 'Delete',
    backspace: 'Backspace',
    insert: 'Insert',
    pageup: 'Page Up',
    pagedown: 'Page Down',
    plus: '+',
  };
  return names[key] ?? key.toUpperCase();
}

function ariaKey(key: string): string {
  const names: Readonly<Record<string, string>> = {
    escape: 'Escape',
    enter: 'Enter',
    tab: 'Tab',
    space: 'Space',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    home: 'Home',
    end: 'End',
    delete: 'Delete',
    backspace: 'Backspace',
    insert: 'Insert',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    plus: 'plus',
  };
  return names[key] ?? key.toUpperCase();
}
