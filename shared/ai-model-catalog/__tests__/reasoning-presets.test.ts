import { describe, expect, it } from 'vitest';
import { profileForReasoningTransport } from '../reasoning-presets.js';

describe('reasoning presets', () => {
  it('offers all five OpenAI effort levels for compatible endpoints', () => {
    const profile = profileForReasoningTransport('openai-effort');

    expect(profile.options.filter((option) => option.kind === 'effort')).toEqual([
      { kind: 'effort', effort: 'low' },
      { kind: 'effort', effort: 'medium' },
      { kind: 'effort', effort: 'high' },
      { kind: 'effort', effort: 'xhigh' },
      { kind: 'effort', effort: 'max' },
    ]);
  });
});
