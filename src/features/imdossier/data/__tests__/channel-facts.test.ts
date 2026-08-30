import { afterEach, describe, expect, it, vi } from 'vitest';

import { messageText, rawText } from '../../../../i18n/presentationText';
import { sinceText, statusText } from '../channel-facts';

afterEach(() => {
  vi.useRealTimers();
});

describe('channel presentation facts', () => {
  it('describes known lifecycle states with locale keys and preserves unknown states', () => {
    expect(statusText('running')).toEqual(messageText('imPlugin.connectionState.live'));
    expect(statusText('provider_specific_state')).toEqual(rawText('provider_specific_state'));
  });

  it('keeps relative times locale-neutral until presentation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T08:00:00.000Z'));

    expect(sinceText('2026-08-24T07:55:00.000Z')).toEqual(
      messageText('imPlugin.relativeTime.minutesEarlier', { count: 5 }),
    );
    expect(sinceText('2026-08-22T08:00:00.000Z')).toEqual(
      messageText('imPlugin.relativeTime.daysEarlier', { count: 2 }),
    );
  });
});
