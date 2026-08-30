import { createContext } from 'react';

import type { RendererRuntime } from './renderer-runtime';

export const RendererRuntimeContext = createContext<RendererRuntime | null>(null);
