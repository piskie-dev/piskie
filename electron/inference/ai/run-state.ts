import type { AiAttemptEvent } from './contracts.js';

export type AiRunPhase =
  | 'created'
  | 'opening_attempt'
  | 'streaming'
  | 'backoff'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AiRunState {
  phase: AiRunPhase;
  attempt: number;
}

export type AiRunObservation =
  | { kind: 'attempt.opened' }
  | { kind: 'attempt.event'; event: AiAttemptEvent }
  | { kind: 'attempt.failed'; retry: boolean }
  | { kind: 'backoff.elapsed' }
  | { kind: 'run.cancelled' };

export function initialAiRunState(): AiRunState {
  return { phase: 'created', attempt: 0 };
}

export function reduceAiRun(state: AiRunState, observation: AiRunObservation): AiRunState {
  if (isTerminalAiState(state)) {
    throw new Error(`AI run is already terminal: ${state.phase}`);
  }

  if (observation.kind === 'run.cancelled') {
    return { ...state, phase: 'cancelled' };
  }

  switch (observation.kind) {
    case 'attempt.opened':
      if (state.phase !== 'created' && state.phase !== 'backoff') {
        throw invalidTransition(state, observation);
      }
      return { phase: 'opening_attempt', attempt: state.attempt + 1 };
    case 'attempt.event': {
      if (state.phase !== 'opening_attempt' && state.phase !== 'streaming') {
        throw invalidTransition(state, observation);
      }
      if (observation.event.kind === 'response.completed') {
        return { ...state, phase: 'completed' };
      }
      return { ...state, phase: 'streaming' };
    }
    case 'attempt.failed':
      if (state.phase !== 'opening_attempt' && state.phase !== 'streaming') {
        throw invalidTransition(state, observation);
      }
      return { ...state, phase: observation.retry ? 'backoff' : 'failed' };
    case 'backoff.elapsed':
      if (state.phase !== 'backoff') {
        throw invalidTransition(state, observation);
      }
      return state;
  }
}

export function isTerminalAiState(state: AiRunState): boolean {
  return state.phase === 'completed' || state.phase === 'failed' || state.phase === 'cancelled';
}

function invalidTransition(state: AiRunState, observation: AiRunObservation): Error {
  return new Error(`Invalid AI run transition: ${state.phase} + ${observation.kind}`);
}
