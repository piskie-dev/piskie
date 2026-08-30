import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SenderAuthorizationRequestInput } from '@shared/types/im-gateway.js';
import { SenderAuthorizationRegistry } from '../sender-authorization-registry.js';

function requestInput(
  overrides: Partial<SenderAuthorizationRequestInput> = {}
): SenderAuthorizationRequestInput {
  return {
    botId: 'bot-1',
    botName: 'Bot 1',
    channel: 'feishu',
    senderId: 'user-1',
    senderName: 'User 1',
    peerType: 'dm',
    peerId: 'user-1',
    ...overrides,
  };
}

describe('SenderAuthorizationRegistry', () => {
  let directory: string;
  let registry: SenderAuthorizationRegistry;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-authorization-'));
    registry = new SenderAuthorizationRegistry(directory);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('owns pending requests and publishes each new request', () => {
    const listener = vi.fn();
    registry.changes.subscribe(listener);
    const result = registry.requestAuthorization(requestInput());
    const pending = registry.listRequests()[0]!;

    expect(result).toEqual({ code: pending.pairingCode, created: true });
    expect(pending.pairingCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(registry.listRequests()).toEqual([pending]);
    expect(listener).toHaveBeenCalledWith(pending);
  });

  it('reuses the pending request for the same bot and sender', () => {
    const first = registry.requestAuthorization(requestInput());
    const second = registry.requestAuthorization(requestInput({ peerId: 'other-peer' }));

    expect(second).toEqual({ code: first.code, created: false });
    expect(registry.listRequests()).toHaveLength(1);
  });

  it('approves a request, removes it from pending, and persists the current user schema', () => {
    registry.requestAuthorization(requestInput());
    const pending = registry.listRequests()[0]!;

    registry.approve(pending.id);

    expect(registry.listRequests()).toEqual([]);
    expect(registry.allowedSenderIds('bot-1')).toEqual(['user-1']);

    const restored = new SenderAuthorizationRegistry(directory);
    restored.load();
    expect(restored.listUsers()).toEqual([
      expect.objectContaining({
        botId: 'bot-1',
        senderId: 'user-1',
        senderName: 'User 1',
        approvedAt: expect.any(String),
      }),
    ]);
  });

  it('rejects a request without granting access', () => {
    registry.requestAuthorization(requestInput());
    const pending = registry.listRequests()[0]!;

    registry.reject(pending.id);

    expect(registry.listRequests()).toEqual([]);
    expect(registry.allowedSenderIds('bot-1')).toEqual([]);
  });

  it('ignores malformed persisted entries and rewrites only canonical fields', () => {
    fs.writeFileSync(
      path.join(directory, 'authorized-users.json'),
      JSON.stringify([
        {
          botId: 'bot-1',
          senderId: 'user-1',
          senderName: 'User 1',
          approvedAt: '2026-08-19T00:00:00.000Z',
          retiredField: true,
        },
        { botId: 42, senderId: 'invalid' },
      ]),
      'utf-8'
    );

    registry.load();
    registry.authorizeSender('bot-1', 'user-2');

    expect(registry.listUsers()).toHaveLength(2);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(directory, 'authorized-users.json'), 'utf-8')
    ) as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).not.toHaveProperty('retiredField');
    expect(Object.keys(persisted[1]!).sort()).toEqual(['approvedAt', 'botId', 'senderId'].sort());
  });
});
