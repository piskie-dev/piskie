import { describe, expect, it } from 'vitest';
import {
  canSubmitImageAttempt,
  initialImageRunState,
  reduceImageRun,
} from '../run-state.js';

describe('ImageRunState', () => {
  it('allows another submit only after an explicitly retryable pre-acceptance failure', () => {
    let state = reduceImageRun(initialImageRunState(), { kind: 'submit.started' });
    state = reduceImageRun(state, { kind: 'submit.failed', retry: true });
    expect(canSubmitImageAttempt(state)).toBe(true);

    state = reduceImageRun(state, { kind: 'backoff.elapsed' });
    state = reduceImageRun(state, { kind: 'submit.started' });
    expect(state.submitAttempt).toBe(2);
  });

  it('can never issue another submit after a job ID is accepted', () => {
    let state = reduceImageRun(initialImageRunState(), { kind: 'submit.started' });
    state = reduceImageRun(state, {
      kind: 'attempt.event',
      event: { kind: 'job.accepted', upstreamJobId: 'prompt-1', resumable: true },
    });

    expect(state.accepted).toBe(true);
    expect(canSubmitImageAttempt(state)).toBe(false);
    expect(() => reduceImageRun(state, { kind: 'submit.started' })).toThrow(/Invalid Image run transition/);
    state = reduceImageRun(state, { kind: 'observe.failed' });
    expect(canSubmitImageAttempt(state)).toBe(false);
  });

  it('tracks synchronous artifacts and completion without inventing a job', () => {
    let state = reduceImageRun(initialImageRunState(), { kind: 'submit.started' });
    state = reduceImageRun(state, {
      kind: 'attempt.event',
      event: { kind: 'artifact', artifact: { artifactId: 'artifact-1', mimeType: 'image/png' } },
    });
    state = reduceImageRun(state, {
      kind: 'attempt.event',
      event: { kind: 'completed', usage: { imageCount: 1 } },
    });

    expect(state).toMatchObject({ phase: 'completed', accepted: false, artifactCount: 1 });
  });
});
