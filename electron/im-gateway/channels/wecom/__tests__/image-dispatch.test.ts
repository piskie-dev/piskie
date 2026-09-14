import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorWeComProvider } from '../vendor/monitor.js';
import { createDeliveryQueue } from '../../../core/outbound.js';
import type { DispatchCallbacks, ReplyDispatcher } from '../../../core/channel-connector.js';

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
  uploadMedia: vi.fn(), sendMediaMessage: vi.fn(), sendMessage: vi.fn(), replyStream: vi.fn(),
}));
vi.mock('@wecom/aibot-node-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@wecom/aibot-node-sdk')>(),
  WSClient: class {
    isConnected = true;
    uploadMedia = sdk.uploadMedia;
    sendMediaMessage = sdk.sendMediaMessage;
    sendMessage = sdk.sendMessage;
    replyStream = sdk.replyStream;
    on(name: string, handler: (...args: unknown[]) => Promise<void>) { sdk.handlers.set(name, handler); }
    connect() {}
    disconnect() {}
  },
}));
vi.mock('../vendor/state-manager.js', () => ({
  startMessageStateCleanup: vi.fn(), stopMessageStateCleanup: vi.fn(),
  setWeComWebSocket: vi.fn(), getWeComWebSocket: vi.fn(), setReqIdForChat: vi.fn(),
  setMessageState: vi.fn(), deleteMessageState: vi.fn(),
  warmupReqIdStore: vi.fn(async () => {}), cleanupAccount: vi.fn(async () => {}),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  sdk.handlers.clear();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

it.each(['single', 'group'])('keeps %s image delivery and error notices working after the thinking stream finishes', async (chattype) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-dispatch-test-'));
  directories.push(directory);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const files = [path.join(directory, 'read.png'), path.join(directory, 'generated.png')];
  await Promise.all(files.map((file) => fs.writeFile(file, png)));
  sdk.uploadMedia.mockResolvedValue({ media_id: 'media-1' });
  sdk.sendMediaMessage.mockResolvedValue({ headers: { req_id: 'sent-1' } });
  const controller = new AbortController();
  let queue: ReplyDispatcher | undefined;
  const running = monitorWeComProvider({
    account: { accountId: 'bot-1', botId: 'bot-1', secret: 'secret', config: { groupPolicy: 'open' }, sendThinkingMessage: false } as never,
    runtime: { log: vi.fn(), error: vi.fn() }, abortSignal: controller.signal,
    media: { saveBuffer: vi.fn() }, pairing: {} as never,
    dispatch: async (_msg, callbacks: DispatchCallbacks) => {
      queue = createDeliveryQueue(callbacks);
      queue.sendToolResult({ mediaUrls: files });
      queue.markComplete();
      await queue.waitForIdle();
      return { kind: 'agent', completion: 'yield', counts: queue.getQueuedCounts() };
    },
  });
  try {
    const chatId = chattype === 'group' ? 'chat-1' : 'user-1';
    await sdk.handlers.get('message')!({ headers: { req_id: 'request-1' }, body: {
      msgid: 'message-1', chattype, from: { userid: 'user-1' },
      ...(chattype === 'group' ? { chatid: chatId } : {}), msgtype: 'text', text: { content: 'Send the images' },
    } });
    expect(sdk.uploadMedia).toHaveBeenCalledTimes(2);
    expect(sdk.uploadMedia).toHaveBeenCalledWith(png, expect.objectContaining({ type: 'image' }));
    expect(sdk.replyStream).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), true);
    sdk.replyStream.mockClear();
    queue!.sendToolResult({ mediaUrls: [files[0]!] });
    await queue!.waitForIdle();
    expect(sdk.sendMediaMessage).toHaveBeenLastCalledWith(chatId, 'image', 'media-1');
    expect(sdk.sendMediaMessage).toHaveBeenCalledTimes(3);
    expect(sdk.replyStream).not.toHaveBeenCalled();
    sdk.uploadMedia.mockRejectedValueOnce(new Error('platform rejected'));
    queue!.sendToolResult({ mediaUrls: files });
    await queue!.waitForIdle();
    expect(sdk.sendMediaMessage).toHaveBeenCalledTimes(4);
    expect(sdk.sendMessage).toHaveBeenCalledOnce();
    expect(sdk.sendMessage).toHaveBeenCalledWith(chatId, {
      msgtype: 'markdown', markdown: { content: expect.stringContaining('1 张成功，1 张失败') },
    });
  } finally {
    controller.abort();
    await running;
  }
});
