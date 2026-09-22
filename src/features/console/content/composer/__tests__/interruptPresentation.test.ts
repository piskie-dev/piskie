import { describe, expect, it } from 'vitest';

import { resolveEffectiveConsoleShortcut } from '../../../data/shortcuts';
import { resolveInterruptPresentation } from '../interruptPresentation';

const target = { agentId: 'session-example', workerId: 'worker-example' } as const;
const shortcut = resolveEffectiveConsoleShortcut('agent.interruptCurrent', {}, 'win32');

describe('resolveInterruptPresentation', () => {
  it('exposes the effective shortcut only for an enabled interrupt owner', () => {
    expect(resolveInterruptPresentation(
      target,
      { kind: 'interrupt', disabled: false },
      true,
      shortcut,
    )).toEqual({
      enabled: true,
      isShortcutOwner: true,
      target,
      shortcut,
      displayShortcut: 'Esc',
      ariaShortcut: 'Escape',
    });
  });

  it.each([
    ['non-owner', { kind: 'interrupt', disabled: false } as const, false, shortcut],
    ['sending', { kind: 'sending', disabled: true } as const, true, shortcut],
    ['interrupt pending', { kind: 'interrupt', disabled: true } as const, true, shortcut],
    ['disabled binding', { kind: 'interrupt', disabled: false } as const, true, null],
  ])('hides the shortcut for %s', (_name, action, owner, effectiveShortcut) => {
    const result = resolveInterruptPresentation(target, action, owner, effectiveShortcut);
    expect(result.shortcut).toBeNull();
    expect(result.displayShortcut).toBeNull();
    expect(result.ariaShortcut).toBeNull();
  });
});
