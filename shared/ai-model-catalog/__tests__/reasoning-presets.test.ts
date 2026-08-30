import { describe, expect, it } from 'vitest';
import {
  normalizeReasoningProfile,
  profileForReasoningTransport,
} from '../reasoning-presets.js';

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

  it('normalizes known OpenAI profiles without changing their default or disabled state', () => {
    const profile = normalizeReasoningProfile({
      mode: 'effort',
      options: [
        { kind: 'disabled' },
        { kind: 'effort', effort: 'medium' },
        { kind: 'effort', effort: 'high' },
      ],
      defaultSelection: { kind: 'effort', effort: 'medium' },
      mandatory: false,
      transportPreset: 'openai-effort',
      replayPolicy: 'opaque-required',
    });

    expect(profile.options).toEqual([
      { kind: 'disabled' },
      { kind: 'effort', effort: 'low' },
      { kind: 'effort', effort: 'medium' },
      { kind: 'effort', effort: 'high' },
      { kind: 'effort', effort: 'xhigh' },
      { kind: 'effort', effort: 'max' },
    ]);
    expect(profile.defaultSelection).toEqual({ kind: 'effort', effort: 'medium' });
  });
});
