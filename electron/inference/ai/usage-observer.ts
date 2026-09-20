import type { AiEvent, AiRequest } from './contracts.js';
import type { RunContext } from '../execution/contracts.js';
import type { CompiledTarget } from '../execution/runtime-snapshot.js';

/** Optional observation only; failures must never affect model execution. */
export interface AiUsageObserver {
  attemptStarted(at: number, attempt: number): void;
  event(event: AiEvent): void;
  close(at: number): Promise<void> | void;
}
export type AiUsageObserverFactory = (request: AiRequest, context: RunContext, target: CompiledTarget) => AiUsageObserver;
