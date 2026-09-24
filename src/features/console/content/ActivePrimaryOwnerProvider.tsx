import { useMemo, type ReactNode } from 'react';

import type { ActionTarget } from '../data/actions';
import {
  ActivePrimaryOwnerContext,
  activePrimaryOwnerId,
  type ActivePrimaryOwnerContextValue,
} from './activePrimaryOwner';

export interface ActivePrimaryOwnerProviderProps {
  readonly owner: ActionTarget | null;
  readonly onActivate: (target: ActionTarget) => void;
  readonly children: ReactNode;
}

export function ActivePrimaryOwnerProvider({
  owner,
  onActivate,
  children,
}: ActivePrimaryOwnerProviderProps) {
  const value = useMemo<ActivePrimaryOwnerContextValue>(() => ({
    ownerId: owner ? activePrimaryOwnerId(owner) : null,
    activate: onActivate,
  }), [onActivate, owner]);
  return (
    <ActivePrimaryOwnerContext.Provider value={value}>
      {children}
    </ActivePrimaryOwnerContext.Provider>
  );
}
