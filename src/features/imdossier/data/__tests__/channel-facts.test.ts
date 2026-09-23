import { afterEach, describe, expect, it, vi } from 'vitest';

import { messageText, rawText } from '../../../../i18n/presentationText';
import type { MessagingConnectionState } from '../../../../../shared/electron-contracts/messaging';
import { connectionGuidanceKey, sinceText, statusText } from '../channel-facts';

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

  it.each([
    ['stopped', 'feishu', undefined, undefined, 'needsTemplate'],
    ['stopped', 'openclaw-weixin', 'task-1', undefined, 'needsSignIn'],
    ['stopped', 'openclaw-weixin', 'task-1', 'account-1', 'needsStart'],
    ['stopped', 'feishu', 'task-1', undefined, 'needsStart'],
    ['starting', 'feishu', 'task-1', undefined, 'starting'],
    ['stopping', 'feishu', 'task-1', undefined, 'stopping'],
    ['stop_failed', 'feishu', 'task-1', undefined, 'stop_failed'],
    ['error', 'feishu', 'task-1', undefined, 'error'],
    ['running', 'feishu', 'task-1', undefined, null],
  ] as const)('resolves %s on %s to %s guidance', (status, channelType, definitionId, pluginAccountId, reason) => {
    const state: MessagingConnectionState = {
      status,
      config: { id: 'bot-1', name: 'Example Bot', channelType, definitionId, pluginAccountId },
    };
    expect(connectionGuidanceKey(state, 'roster')).toBe(reason && `imPlugin.roster.guidance.${reason}`);
    expect(connectionGuidanceKey(state, 'dossier')).toBe(reason && `imPlugin.dossier.guidance.${reason}`);
  });
});
