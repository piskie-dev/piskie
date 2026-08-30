import type { ReactNode } from 'react';

import { RendererRuntimeContext } from './renderer-runtime-context';
import type { RendererRuntime } from './renderer-runtime';

export function RendererRuntimeProvider({
  runtime,
  children,
}: {
  readonly runtime: RendererRuntime;
  readonly children: ReactNode;
}) {
  return (
    <RendererRuntimeContext.Provider value={runtime}>
      {children}
    </RendererRuntimeContext.Provider>
  );
}
