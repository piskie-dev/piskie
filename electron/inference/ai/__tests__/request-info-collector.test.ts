import { describe, expect, it } from 'vitest';

import { AIRequestInfoCollector } from '../request-info-collector.js';

describe('AIRequestInfoCollector', () => {
  it('measures first visible content from the final retry attempt', () => {
    const collector = new AIRequestInfoCollector();

    collector.onAttemptStarted(100);
    collector.onAttemptStarted(500);
    collector.onVisibleContent(540);
    collector.onVisibleContent(560);

    expect(collector.complete(700)).toEqual({
      firstVisibleContentLatencyMs: 40,
      generationDurationMs: 160,
    });
  });

  it('keeps tool-only and terminal-before-visible runs unknown', () => {
    const collector = new AIRequestInfoCollector();

    collector.onAttemptStarted(100);

    expect(collector.complete(250)).toEqual({});
  });

  it('can measure generation duration without inventing TTFT', () => {
    const collector = new AIRequestInfoCollector();

    collector.onVisibleContent(200);

    expect(collector.complete(260)).toEqual({ generationDurationMs: 60 });
  });

  it('resets visible timing when a new attempt starts', () => {
    const collector = new AIRequestInfoCollector();

    collector.onAttemptStarted(100);
    collector.onVisibleContent(120);
    collector.onAttemptStarted(300);

    expect(collector.complete(400)).toEqual({});
  });
});
