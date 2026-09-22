import { describe, expect, it, vi } from 'vitest';

import { createShortcutRouter } from '../router';
import type {
  ShortcutBinding,
  ShortcutKeyEvent,
  ShortcutLayer,
  ShortcutScope,
} from '../types';

interface ExecuteOptions {
  readonly enabled?: () => boolean;
  readonly allowInEditable?: boolean;
  readonly repeat?: boolean;
  readonly defaultBehavior?: 'prevent' | 'preserve';
}

function executeBinding(
  id: string,
  combo: string,
  execute: () => void,
  options: ExecuteOptions = {},
): ShortcutBinding {
  return {
    id,
    commandId: `command.${id}`,
    combo,
    enabled: options.enabled ?? (() => true),
    allowInEditable: options.allowInEditable,
    repeat: options.repeat,
    handling: 'execute',
    defaultBehavior: options.defaultBehavior ?? 'prevent',
    execute,
  };
}

function delegateBinding(id: string, combo: string): ShortcutBinding {
  return {
    id,
    commandId: `command.${id}`,
    combo,
    enabled: () => true,
    allowInEditable: true,
    handling: 'delegate-dismiss',
    defaultBehavior: 'preserve',
  };
}

function scope(
  id: string,
  layer: ShortcutLayer,
  bindings: readonly ShortcutBinding[],
  options: Pick<ShortcutScope, 'blocksLowerLayers' | 'parentScopeId'> = {
    blocksLowerLayers: 'none',
  },
): ShortcutScope {
  return { id, layer, bindings, ...options };
}

function key(
  value: string,
  preventDefault = vi.fn(),
  overrides: Partial<ShortcutKeyEvent> = {},
): ShortcutKeyEvent {
  return { key: value, preventDefault, ...overrides };
}

describe('shortcut router ordering', () => {
  it('uses the fixed layers instead of registration order and executes one winner', () => {
    const router = createShortcutRouter();
    const calls: string[] = [];
    const registrations = [
      ['application', 'application'],
      ['page', 'page'],
      ['navigation', 'mode-navigation'],
      ['focused', 'focused-control-fallback'],
      ['owner', 'active-primary-action'],
      ['transient', 'mode-transient'],
      ['exclusive', 'exclusive-input'],
    ] as const;
    const dispose = new Map<string, () => void>();

    for (const [id, layer] of registrations) {
      dispose.set(id, router.registerScope(scope(
        id,
        layer,
        [executeBinding(`${id}-binding`, 'escape', () => calls.push(id))],
      )));
    }
    router.activateFocusedScope('focused');
    router.activateOwnerScope('owner');

    const expected = ['exclusive', 'transient', 'owner', 'focused', 'navigation', 'page', 'application'];
    for (const id of expected) {
      expect(router.dispatch(key('Escape')).kind).toBe('executed');
      expect(calls.at(-1)).toBe(id);
      dispose.get(id)?.();
    }
    expect(calls).toEqual(expected);
  });

  it('only evaluates the activated focused and owner scopes', () => {
    const router = createShortcutRouter();
    const focusedA = vi.fn();
    const focusedB = vi.fn();
    const ownerA = vi.fn();
    const ownerB = vi.fn();

    router.registerScope(scope('focused-a', 'focused-control-fallback', [
      executeBinding('focused-a-binding', 'ctrl+b', focusedA),
    ]));
    router.registerScope(scope('focused-b', 'focused-control-fallback', [
      executeBinding('focused-b-binding', 'ctrl+b', focusedB),
    ]));
    router.registerScope(scope('owner-a', 'active-primary-action', [
      executeBinding('owner-a-binding', 'escape', ownerA, { allowInEditable: true }),
    ]));
    router.registerScope(scope('owner-b', 'active-primary-action', [
      executeBinding('owner-b-binding', 'escape', ownerB, { allowInEditable: true }),
    ]));

    router.activateFocusedScope('focused-b');
    router.activateOwnerScope('owner-a');
    router.dispatch(key('b', vi.fn(), { ctrlKey: true }));
    router.dispatch(key('Escape', vi.fn(), { editableTarget: true }));

    expect(focusedA).not.toHaveBeenCalled();
    expect(focusedB).toHaveBeenCalledOnce();
    expect(ownerA).toHaveBeenCalledOnce();
    expect(ownerB).not.toHaveBeenCalled();
  });

  it('lets a disabled higher-layer binding fall through to a lower layer', () => {
    const router = createShortcutRouter();
    const lower = vi.fn();
    router.registerScope(scope('owner', 'active-primary-action', [
      executeBinding('disabled', 'escape', vi.fn(), { enabled: () => false }),
    ]));
    router.registerScope(scope('page', 'page', [executeBinding('lower', 'escape', lower)]));
    router.activateOwnerScope('owner');

    expect(router.dispatch(key('Escape')).kind).toBe('executed');
    expect(lower).toHaveBeenCalledOnce();
  });
});

describe('overlay stack and barriers', () => {
  it('orders descendants above parents even when the child registers first', () => {
    const router = createShortcutRouter();
    const child = vi.fn();
    const parent = vi.fn();
    const disposeChild = router.registerScope(scope(
      'child',
      'overlay',
      [executeBinding('child-dismiss', 'escape', child)],
      { blocksLowerLayers: 'none', parentScopeId: 'parent' },
    ));
    router.registerScope(scope(
      'parent',
      'overlay',
      [executeBinding('parent-dismiss', 'escape', parent)],
      { blocksLowerLayers: 'all' },
    ));

    expect(router.dispatch(key('Escape'))).toMatchObject({ kind: 'executed', scopeId: 'child' });
    expect(child).toHaveBeenCalledOnce();
    expect(parent).not.toHaveBeenCalled();

    disposeChild();
    expect(router.dispatch(key('Escape'))).toMatchObject({ kind: 'executed', scopeId: 'parent' });
    expect(parent).toHaveBeenCalledOnce();
  });

  it('uses newest siblings first and releases descendants with their parent', () => {
    const router = createShortcutRouter();
    const first = vi.fn();
    const second = vi.fn();
    const disposeParent = router.registerScope(scope('parent', 'overlay', [], {
      blocksLowerLayers: 'none',
    }));
    router.registerScope(scope('first', 'overlay', [executeBinding('first', 'escape', first)], {
      blocksLowerLayers: 'none',
      parentScopeId: 'parent',
    }));
    router.registerScope(scope('second', 'overlay', [executeBinding('second', 'escape', second)], {
      blocksLowerLayers: 'none',
      parentScopeId: 'parent',
    }));

    expect(router.dispatch(key('Escape'))).toMatchObject({ scopeId: 'second' });
    disposeParent();
    expect(router.dispatch(key('Escape'))).toEqual({ kind: 'no-op' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('interleaves unrelated overlays by open order while keeping a child above its parent', () => {
    const router = createShortcutRouter();
    const parent = vi.fn();
    const unrelated = vi.fn();
    const child = vi.fn();
    const disposeParent = router.registerScope(scope('parent', 'overlay', [
      executeBinding('parent', 'escape', parent),
    ]));
    const disposeUnrelated = router.registerScope(scope('unrelated', 'overlay', [
      executeBinding('unrelated', 'escape', unrelated),
    ]));
    const disposeChild = router.registerScope(scope('child', 'overlay', [
      executeBinding('child', 'escape', child),
    ], {
      blocksLowerLayers: 'none',
      parentScopeId: 'parent',
    }));

    expect(router.dispatch(key('Escape'))).toMatchObject({ scopeId: 'child' });
    disposeChild();
    expect(router.dispatch(key('Escape'))).toMatchObject({ scopeId: 'unrelated' });
    disposeUnrelated();
    expect(router.dispatch(key('Escape'))).toMatchObject({ scopeId: 'parent' });
    disposeParent();
  });

  it('blocks lower layers without preventing the browser default', () => {
    const router = createShortcutRouter();
    const preventDefault = vi.fn();
    const page = vi.fn();
    router.registerScope(scope('page', 'page', [
      executeBinding('page-custom', 'ctrl+x', page),
      executeBinding('page-escape', 'escape', page),
    ]));
    router.registerScope(scope('modal', 'overlay', [], { blocksLowerLayers: 'all' }));

    expect(router.dispatch(key('x', preventDefault, { ctrlKey: true }))).toEqual({
      kind: 'blocked',
      layer: 'overlay',
      scopeIds: ['modal'],
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();

    expect(router.dispatch(key('Escape', preventDefault))).toMatchObject({ kind: 'blocked' });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  });

  it('allows an unclaimed combo through a non-blocking overlay', () => {
    const router = createShortcutRouter();
    const page = vi.fn();
    router.registerScope(scope('page', 'page', [executeBinding('page', 'ctrl+x', page)]));
    router.registerScope(scope('flyout', 'overlay', [delegateBinding('dismiss', 'escape')]));

    expect(router.dispatch(key('x', vi.fn(), { ctrlKey: true })).kind).toBe('executed');
    expect(page).toHaveBeenCalledOnce();
  });
});

describe('binding handling contracts', () => {
  it('preserves default behavior for a no-op', () => {
    const router = createShortcutRouter();
    const preventDefault = vi.fn();

    expect(router.dispatch(key('Escape', preventDefault))).toEqual({ kind: 'no-op' });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('prevents default before invoking an execute callback', () => {
    const router = createShortcutRouter();
    const order: string[] = [];
    const preventDefault = vi.fn(() => order.push('prevent'));
    router.registerScope(scope('page', 'page', [
      executeBinding('execute', 'escape', () => order.push('execute')),
    ]));

    expect(router.dispatch(key('Escape', preventDefault)).kind).toBe('executed');
    expect(order).toEqual(['prevent', 'execute']);
  });

  it('supports execute with preserved default behavior', () => {
    const router = createShortcutRouter();
    const execute = vi.fn();
    const preventDefault = vi.fn();
    router.registerScope(scope('page', 'page', [
      executeBinding('preserve', 'escape', execute, { defaultBehavior: 'preserve' }),
    ]));

    expect(router.dispatch(key('Escape', preventDefault)).kind).toBe('executed');
    expect(execute).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('claims delegate-dismiss without executing or preventing', () => {
    const router = createShortcutRouter();
    const page = vi.fn();
    const preventDefault = vi.fn();
    router.registerScope(scope('dialog', 'overlay', [delegateBinding('native-dismiss', 'escape')], {
      blocksLowerLayers: 'all',
    }));
    router.registerScope(scope('page', 'page', [executeBinding('page', 'escape', page)]));

    expect(router.dispatch(key('Escape', preventDefault))).toEqual({
      kind: 'delegated',
      scopeId: 'dialog',
      bindingId: 'native-dismiss',
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  });
});

describe('keydown eligibility', () => {
  it('requires allowInEditable and supports an explicit editable binding', () => {
    const blockedRouter = createShortcutRouter();
    const blocked = vi.fn();
    blockedRouter.registerScope(scope('page', 'page', [
      executeBinding('blocked', 'escape', blocked),
    ]));
    expect(blockedRouter.dispatch(key('Escape', vi.fn(), { editableTarget: true }))).toEqual({
      kind: 'no-op',
    });
    expect(blocked).not.toHaveBeenCalled();

    const allowedRouter = createShortcutRouter();
    const allowed = vi.fn();
    allowedRouter.registerScope(scope('owner', 'active-primary-action', [
      executeBinding('allowed', 'ctrl+shift+x', allowed, { allowInEditable: true }),
    ]));
    allowedRouter.activateOwnerScope('owner');
    expect(allowedRouter.dispatch(key('x', vi.fn(), {
      ctrlKey: true,
      shiftKey: true,
      editableTarget: true,
    })).kind).toBe('executed');
    expect(allowed).toHaveBeenCalledOnce();
  });

  it('ignores default-prevented and composing events', () => {
    const router = createShortcutRouter();
    const execute = vi.fn();
    router.registerScope(scope('page', 'page', [executeBinding('page', 'escape', execute)]));

    expect(router.dispatch(key('Escape', vi.fn(), { defaultPrevented: true }))).toEqual({
      kind: 'ignored',
      reason: 'default-prevented',
    });
    expect(router.dispatch(key('Escape', vi.fn(), { isComposing: true }))).toEqual({
      kind: 'ignored',
      reason: 'composing',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('only accepts repeated events for bindings that opt in', () => {
    const router = createShortcutRouter();
    const noRepeat = vi.fn();
    const repeat = vi.fn();
    const dispose = router.registerScope(scope('page', 'page', [
      executeBinding('no-repeat', 'escape', noRepeat),
    ]));

    expect(router.dispatch(key('Escape', vi.fn(), { repeat: true }))).toEqual({ kind: 'no-op' });
    dispose();
    router.registerScope(scope('page-repeat', 'page', [
      executeBinding('repeat', 'escape', repeat, { repeat: true }),
    ]));
    expect(router.dispatch(key('Escape', vi.fn(), { repeat: true })).kind).toBe('executed');
    expect(noRepeat).not.toHaveBeenCalled();
    expect(repeat).toHaveBeenCalledOnce();
  });

  it('matches concrete ctrl/meta combos separately while retaining the legacy mod alias', () => {
    const router = createShortcutRouter();
    const ctrl = vi.fn();
    const meta = vi.fn();
    const legacy = vi.fn();
    router.registerScope(scope('ctrl', 'page', [executeBinding('ctrl', 'ctrl+b', ctrl)]));

    router.dispatch(key('b', vi.fn(), { ctrlKey: true }));
    router.dispatch(key('b', vi.fn(), { metaKey: true }));
    expect(ctrl).toHaveBeenCalledOnce();

    router.reset();
    router.registerScope(scope('meta', 'page', [executeBinding('meta', 'meta+b', meta)]));
    router.dispatch(key('b', vi.fn(), { metaKey: true }));
    expect(meta).toHaveBeenCalledOnce();

    router.reset();
    router.registerScope(scope('legacy', 'page', [executeBinding('legacy', 'mod+b', legacy)]));
    router.dispatch(key('b', vi.fn(), { ctrlKey: true }));
    router.dispatch(key('b', vi.fn(), { metaKey: true }));
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it('normalizes browser key names to canonical space and plus tokens', () => {
    const router = createShortcutRouter();
    const space = vi.fn();
    const plus = vi.fn();
    router.registerScope(scope('page', 'page', [
      executeBinding('space', 'space', space),
      executeBinding('plus', 'ctrl+plus', plus),
    ]));

    router.dispatch(key(' '));
    router.dispatch(key('+', vi.fn(), { ctrlKey: true }));
    expect(space).toHaveBeenCalledOnce();
    expect(plus).toHaveBeenCalledOnce();
  });
});

describe('ambiguity handling', () => {
  it('reports same-position conflicts and executes neither binding', () => {
    const onConflict = vi.fn();
    const router = createShortcutRouter({ onConflict });
    const first = vi.fn();
    const second = vi.fn();
    const preventDefault = vi.fn();
    router.registerScope(scope('page-owner', 'page', [
      executeBinding('first', 'escape', first),
      executeBinding('second', 'escape', second),
    ]));

    expect(router.dispatch(key('Escape', preventDefault))).toMatchObject({
      kind: 'conflict',
      combo: 'escape',
      layer: 'page',
      scopeIds: ['page-owner'],
      bindingIds: ['first', 'second'],
    });
    expect(onConflict).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not use registration order to choose between active peer scopes', () => {
    const onConflict = vi.fn();
    const router = createShortcutRouter({ onConflict });
    const first = vi.fn();
    const second = vi.fn();
    router.registerScope(scope('first-page-owner', 'page', [executeBinding('first', 'escape', first)]));
    router.registerScope(scope('second-page-owner', 'page', [executeBinding('second', 'escape', second)]));

    expect(router.dispatch(key('Escape')).kind).toBe('conflict');
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('allows one enabled binding to be the unique winner', () => {
    const router = createShortcutRouter();
    const winner = vi.fn();
    router.registerScope(scope('page-owner', 'page', [
      executeBinding('disabled', 'escape', vi.fn(), { enabled: () => false }),
      executeBinding('winner', 'escape', winner),
    ]));

    expect(router.dispatch(key('Escape'))).toMatchObject({ kind: 'executed', bindingId: 'winner' });
    expect(winner).toHaveBeenCalledOnce();
  });
});

describe('scope and binding registration', () => {
  it('accepts a child binding effect before its scope effect', () => {
    const router = createShortcutRouter();
    const execute = vi.fn();
    const disposeBinding = router.registerBinding(
      'parent-scope',
      executeBinding('child-binding', 'escape', execute),
    );

    expect(router.dispatch(key('Escape'))).toEqual({ kind: 'no-op' });
    const disposeScope = router.registerScope(scope('parent-scope', 'page', []));
    expect(router.dispatch(key('Escape'))).toMatchObject({
      kind: 'executed',
      scopeId: 'parent-scope',
      bindingId: 'child-binding',
    });

    disposeBinding();
    expect(router.dispatch(key('Escape'))).toEqual({ kind: 'no-op' });
    disposeScope();
  });

  it('removes a separately registered binding with its scope', () => {
    const router = createShortcutRouter();
    const execute = vi.fn();
    const disposeScope = router.registerScope(scope('page', 'page', []));
    router.registerBinding('page', executeBinding('binding', 'escape', execute));
    disposeScope();

    expect(router.dispatch(key('Escape'))).toEqual({ kind: 'no-op' });
    expect(execute).not.toHaveBeenCalled();
  });
});
