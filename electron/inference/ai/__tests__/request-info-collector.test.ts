import { describe, expect, it } from 'vitest';

import { AIRequestInfoCollector } from '../request-info-collector.js';

describe('AIRequestInfoCollector', () => {
  it('measures first token and full duration from the final retry attempt', () => {
    const collector = new AIRequestInfoCollector();

    collector.onAttemptStarted(100);
    collector.onAttemptStarted(500);
    collector.onFirstToken(540);
    collector.onFirstToken(560);

    expect(collector.complete(700)).toEqual({
      firstTokenLatencyMs: 40,
      attemptDurationMs: 200,
    });
  });

  it('measures the full attempt without an observed first token', () => {
    const collector = new AIRequestInfoCollector();

    collector.onAttemptStarted(100);

    expect(collector.complete(250)).toEqual({ attemptDurationMs: 150 });
  });

  it('keeps statistics unknown when no attempt has started', () => {
    const collector = new AIRequestInfoCollector();

    expect(collector.complete(260)).toEqual({});
  });

  it('preserves a measured zero-duration attempt', () => {
    const collector = new AIRequestInfoCollector();
    collector.onAttemptStarted(100);

    expect(collector.complete(100)).toEqual({ attemptDurationMs: 0 });
  });

  it('resets first token timing when a new attempt starts', () => {
    const collector = new AIRequestInfoCollector();

    collector.onAttemptStarted(100);
    collector.onFirstToken(120);
    collector.onAttemptStarted(300);

    expect(collector.complete(400)).toEqual({ attemptDurationMs: 100 });
  });
});
