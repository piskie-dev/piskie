import { createContext } from 'react';

/** Each transcript location grants activity only to its current dispatch owner. */
export const WorkerActivityVisibility = createContext(true);
