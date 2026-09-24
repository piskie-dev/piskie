import { describe, expect, it } from 'vitest';

import { resolveEffectiveConsoleShortcut } from '../shortcuts';

describe('resolveEffectiveConsoleShortcut', () => {
  it.each([
    ['darwin', 'meta+\\', '⌘\\', 'Meta+\\'],
    ['win32', 'ctrl+\\', 'Ctrl+\\', 'Control+\\'],
    ['linux', 'ctrl+\\', 'Ctrl+\\', 'Control+\\'],
  ] as const)('expands the default primary modifier on %s', (platform, physicalCombo, display, aria) => {
    expect(resolveEffectiveConsoleShortcut('console.toggleLayout', {}, platform)).toEqual({
      canonical: 'primary+\\',
      physicalCombo,
      display,
      aria,
      platform,
    });
  });

  it('uses a configured override for physical matching and presentation', () => {
    expect(resolveEffectiveConsoleShortcut(
      'agent.interruptCurrent',
      { 'agent.interruptCurrent': 'primary+shift+x' },
      'darwin',
    )).toEqual({
      canonical: 'primary+shift+x',
      physicalCombo: 'meta+shift+x',
      display: '⌘⇧X',
      aria: 'Meta+Shift+X',
      platform: 'darwin',
    });
  });

  it('returns null when a configurable command is disabled', () => {
    expect(resolveEffectiveConsoleShortcut(
      'tool.promoteToBackground',
      { 'tool.promoteToBackground': null },
      'win32',
    )).toBeNull();
  });

  it('normalizes an unknown desktop platform to Linux semantics', () => {
    expect(resolveEffectiveConsoleShortcut('tool.promoteToBackground', {}, 'freebsd'))
      .toMatchObject({ physicalCombo: 'ctrl+b', display: 'Ctrl+B', platform: 'linux' });
  });
});
