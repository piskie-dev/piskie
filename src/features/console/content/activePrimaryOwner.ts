import { createContext, useCallback, useContext } from 'react';

import type { ActionTarget } from '../data/actions';

export interface ActivePrimaryOwnerContextValue {
  readonly ownerId: string | null;
  readonly activate: (target: ActionTarget) => void;
}

export const ActivePrimaryOwnerContext = createContext<ActivePrimaryOwnerContextValue | null>(null);

export function activePrimaryOwnerId(target: ActionTarget): string {
  return target.workerId
    ? `agent:${target.agentId}:worker:${target.workerId}`
    : `agent:${target.agentId}`;
}

export interface ActivePrimaryOwnerState {
  readonly isShortcutOwner: boolean;
  readonly activateShortcutOwner: () => void;
}

export function useActivePrimaryOwner(target: ActionTarget): ActivePrimaryOwnerState {
  const context = useContext(ActivePrimaryOwnerContext);
  const targetId = activePrimaryOwnerId(target);
  const activateShortcutOwner = useCallback(() => {
    context?.activate(target);
  }, [context, target]);
  return {
    // Thread renders one current target and intentionally has no multi-panel provider.
    isShortcutOwner: context === null || context.ownerId === targetId,
    activateShortcutOwner,
  };
}
