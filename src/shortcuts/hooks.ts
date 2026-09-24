import { useCallback, useEffect } from 'react';

import { mountShortcutListener } from './dom';
import {
  activateFocusedShortcutScope,
  activateShortcutOwner,
  getFocusedShortcutScope,
  getShortcutOwner,
  registerShortcutBinding,
  registerShortcutScope,
} from './router';
import type { ShortcutBinding, ShortcutScope } from './types';

export function useShortcutListener(target?: Window): void {
  useEffect(() => mountShortcutListener(target ?? window), [target]);
}

export function useShortcutScope(scope: ShortcutScope, active = true): void {
  useEffect(() => {
    if (!active) return;
    return registerShortcutScope(scope);
  }, [active, scope]);
}

export function useShortcutBinding(
  scopeId: string,
  binding: ShortcutBinding,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    return registerShortcutBinding(scopeId, binding);
  }, [active, binding, scopeId]);
}

export function useFocusedShortcutScope(scopeId: string, active = true): void {
  useEffect(() => {
    if (!active) return;
    activateFocusedShortcutScope(scopeId);
    return () => {
      if (getFocusedShortcutScope() === scopeId) activateFocusedShortcutScope(null);
    };
  }, [active, scopeId]);
}

export function useShortcutOwner(scopeId: string, active = true): void {
  useEffect(() => {
    if (!active) return;
    activateShortcutOwner(scopeId);
    return () => {
      if (getShortcutOwner() === scopeId) activateShortcutOwner(null);
    };
  }, [active, scopeId]);
}

export interface ShortcutScopeActivators {
  readonly activateFocused: () => void;
  readonly activateOwner: () => void;
}

export function useShortcutScopeActivators(scopeId: string): ShortcutScopeActivators {
  const activateFocused = useCallback(() => activateFocusedShortcutScope(scopeId), [scopeId]);
  const activateOwner = useCallback(() => activateShortcutOwner(scopeId), [scopeId]);
  return { activateFocused, activateOwner };
}
