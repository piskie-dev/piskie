import type { ReactNode } from 'react';

import { ShortcutOverlayParentContext } from './overlayContext';

export interface ShortcutOverlayParentProviderProps {
  readonly scopeId: string;
  readonly children?: ReactNode;
}

export function ShortcutOverlayParentProvider({
  scopeId,
  children,
}: ShortcutOverlayParentProviderProps) {
  return (
    <ShortcutOverlayParentContext.Provider value={scopeId}>
      {children}
    </ShortcutOverlayParentContext.Provider>
  );
}
