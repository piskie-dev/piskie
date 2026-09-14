import { afterAll, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startGateway } from '../vendor/src/gateway.js';
import { setQQBotRuntime } from '../vendor/src/runtime.js';
import { OpenClawRuntimeHost } from '../../../core/openclaw-runtime-host.js';
import type { ConnectorContext, InboundMessage, ReplyDispatcher } from '../../../core/channel-connector.js';

const harness = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    directory: fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dispatch-test-')),
    process: undefined as ((event: Record<string, unknown>) => Promise<void>) | undefined,
    ready: Promise.withResolvers<void>(),
  };
});
vi.mock('ws', () => ({ default: class {
  static OPEN = 1;
  readyState = 1;
  on(event: string, callback: () => void) { if (event === 'open') callback(); }
  close() {}
} }));
vi.mock('../vendor/src/utils/platform.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    ...await importOriginal<Record<string, unknown>>(),
    runDiagnostics: async () => ({ warnings: [] }),
    getQQBotDataDir: (...parts: string[]) => {
      const directory = path.join(harness.directory, ...parts);
      fs.mkdirSync(directory, { recursive: true });
      return directory;
    },
  };
});
vi.mock('../vendor/src/api.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getAccessToken: async () => 'token', getGatewayUrl: async () => 'wss://gateway.example.test',
  startBackgroundTokenRefresh: vi.fn(), stopBackgroundTokenRefresh: vi.fn(), sendC2CInputNotify: async () => ({}),
}));
vi.mock('../vendor/src/update-checker.js', () => ({ triggerUpdateCheck: vi.fn() }));
vi.mock('../vendor/src/approval-handler.js', () => ({
  QQBotApprovalHandler: class { async start() {} async stop() {} },
  registerApprovalHandler: vi.fn(), unregisterApprovalHandler: vi.fn(), getApprovalHandler: vi.fn(),
}));
vi.mock('../vendor/src/message-queue.js', () => ({ createMessageQueue: () => ({
  startProcessor: (process: typeof harness.process) => { harness.process = process; harness.ready.resolve(); },
  waitForIdle: async () => {},
}) }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); harness.ready = Promise.withResolvers<void>(); });
afterAll(async () => { await fs.rm(harness.directory, { recursive: true, force: true }); });

it.each(['c2c', 'group', 'guild', 'dm'])('delivers pure images on %s without a later text fallback, and retains the original target', async (type) => {
  vi.useFakeTimers();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const files = [path.join(harness.directory, 'read.png'), path.join(harness.directory, 'generated.png')];
  await Promise.all(files.map((file) => fs.writeFile(file, png)));
  const requests: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    requests.push({ url, body: options.body instanceof FormData ? options.body : JSON.parse(options.body as string) });
    return Response.json(url.endsWith('/files') ? { file_info: 'image-info' } : { id: 'sent-1' });
  }));
  const host = new OpenClawRuntimeHost('qqbot');
  const controller = new AbortController();
  let queue: ReplyDispatcher | undefined;
  const messages: InboundMessage[] = [];
  host.register({
    bot: { id: 'bot-1', channelType: 'qqbot', name: 'Bot', appId: 'app-1', appSecret: 'secret', groupPolicy: 'open', requireMention: false },
    signal: controller.signal,
    dispatchWithQueue: async (message: InboundMessage, dispatcher: ReplyDispatcher) => {
      messages.push(message);
      queue = dispatcher;
      dispatcher.sendToolResult({ mediaUrls: files });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return { kind: 'agent', completion: 'yield', counts: dispatcher.getQueuedCounts() };
    },
  } as unknown as ConnectorContext);
  setQQBotRuntime(host.buildRuntime());
  const errors = vi.fn();
  const running = startGateway({
    account: { accountId: 'bot-1', appId: 'app-1', clientSecret: 'secret', enabled: true, config: { groupPolicy: 'open', requireMention: false } },
    cfg: host.loadConfig(), abortSignal: controller.signal, log: { info: vi.fn(), error: errors },
  });
  try {
    await harness.ready.promise;
    await harness.process!({ type, senderId: 'user-1', messageId: 'message-1', content: 'Send images',
      timestamp: '2026-01-01T00:00:00Z', groupOpenid: 'group-1', guildId: 'guild-1', channelId: 'channel-1',
      eventType: 'GROUP_AT_MESSAGE_CREATE',
    });
    expect(messages).toHaveLength(1);
    if (type === 'dm') expect(messages[0].peer.id).toBe('guild-1');
    const endpoint = type === 'c2c' ? '/v2/users/user-1/messages' : type === 'group' ? '/v2/groups/group-1/messages'
      : type === 'guild' ? '/channels/channel-1/messages' : '/dms/guild-1/messages';
    const sent = () => requests.filter(({ url }) => url.endsWith('/messages'));
    expect(sent()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(sent()).toHaveLength(2);
    queue!.sendToolResult({ mediaUrls: [files[0]!] });
    await queue!.waitForIdle();
    expect(sent()).toHaveLength(3);
    expect(sent().every(({ url }) => url.endsWith(endpoint))).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await running;
  }
});
