import { describe, expect, it } from 'vitest';
import { initialAiRunState, isTerminalAiState, reduceAiRun } from '../run-state.js';

describe('AiRunState', () => {
  it('follows the retry decision before any streamed output', () => {
    let state = reduceAiRun(initialAiRunState(), { kind: 'attempt.opened' });
    state = reduceAiRun(state, { kind: 'attempt.failed', retry: true });
    expect(state.phase).toBe('backoff');

    state = reduceAiRun(state, { kind: 'backoff.elapsed' });
    state = reduceAiRun(state, { kind: 'attempt.opened' });
    expect(state.attempt).toBe(2);
  });

  it('follows the retry decision after text is visible', () => {
    let state = reduceAiRun(initialAiRunState(), { kind: 'attempt.opened' });
    state = reduceAiRun(state, { kind: 'attempt.event', event: { kind: 'text.delta', text: 'visible' } });
    state = reduceAiRun(state, { kind: 'attempt.failed', retry: true });

    expect(state.phase).toBe('backoff');
    expect(isTerminalAiState(state)).toBe(false);
    state = reduceAiRun(state, { kind: 'backoff.elapsed' });
    state = reduceAiRun(state, { kind: 'attempt.opened' });
    expect(state).toEqual({ phase: 'opening_attempt', attempt: 2 });
  });

  it('reaches completed through the same stream state', () => {
    let state = reduceAiRun(initialAiRunState(), { kind: 'attempt.opened' });
    state = reduceAiRun(state, {
      kind: 'attempt.event',
      event: { kind: 'response.completed', stopReason: 'end_turn' },
    });

    expect(state).toEqual({ phase: 'completed', attempt: 1 });
  });
});
