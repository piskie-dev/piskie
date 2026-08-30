import type { ImageAttemptEvent } from './driver-port.js';

export type ImageRunPhase =
  | 'created'
  | 'submitting'
  | 'backoff'
  | 'observing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ImageRunState {
  phase: ImageRunPhase;
  submitAttempt: number;
  accepted: boolean;
  artifactCount: number;
}

export type ImageRunObservation =
  | { kind: 'submit.started' }
  | { kind: 'submit.failed'; retry: boolean }
  | { kind: 'backoff.elapsed' }
  | { kind: 'attempt.event'; event: ImageAttemptEvent }
  | { kind: 'observe.failed' }
  | { kind: 'run.cancelled' };

export function initialImageRunState(): ImageRunState {
  return { phase: 'created', submitAttempt: 0, accepted: false, artifactCount: 0 };
}

export function reduceImageRun(state: ImageRunState, observation: ImageRunObservation): ImageRunState {
  if (isTerminalImageState(state)) throw new Error(`Image run is already terminal: ${state.phase}`);

  if (observation.kind === 'run.cancelled') return { ...state, phase: 'cancelled' };
  switch (observation.kind) {
    case 'submit.started':
      if (state.accepted || (state.phase !== 'created' && state.phase !== 'backoff')) {
        throw invalidTransition(state, observation.kind);
      }
      return { ...state, phase: 'submitting', submitAttempt: state.submitAttempt + 1 };
    case 'submit.failed':
      if (state.phase !== 'submitting' || state.accepted) throw invalidTransition(state, observation.kind);
      return { ...state, phase: observation.retry ? 'backoff' : 'failed' };
    case 'backoff.elapsed':
      if (state.phase !== 'backoff' || state.accepted) throw invalidTransition(state, observation.kind);
      return state;
    case 'attempt.event': {
      const event = observation.event;
      if (state.phase !== 'submitting' && state.phase !== 'observing') {
        throw invalidTransition(state, observation.kind);
      }
      if (event.kind === 'job.accepted') {
        if (state.accepted) throw new Error('Image job was accepted more than once');
        return { ...state, phase: 'observing', accepted: true };
      }
      if (event.kind === 'artifact') {
        return { ...state, artifactCount: state.artifactCount + 1 };
      }
      if (event.kind === 'completed') return { ...state, phase: 'completed' };
      return state;
    }
    case 'observe.failed':
      if (!state.accepted || state.phase !== 'observing') throw invalidTransition(state, observation.kind);
      return { ...state, phase: 'failed' };
  }
}

export function isTerminalImageState(state: ImageRunState): boolean {
  return state.phase === 'completed' || state.phase === 'failed' || state.phase === 'cancelled';
}

export function canSubmitImageAttempt(state: ImageRunState): boolean {
  return !state.accepted && (state.phase === 'created' || state.phase === 'backoff');
}

function invalidTransition(state: ImageRunState, observation: string): Error {
  return new Error(`Invalid Image run transition: ${state.phase} + ${observation}`);
}
