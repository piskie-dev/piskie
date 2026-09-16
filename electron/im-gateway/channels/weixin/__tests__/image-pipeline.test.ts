import { afterAll, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processOneMessage } from '../vendor/src/messaging/process-message.js';
import { OpenClawRuntimeHost } from '../../../core/openclaw-runtime-host.js';
import { createChannelStorageFixture } from '@electron/testing/im-channel-storage.fixture.js';
import type { ConnectorContext, ReplyDispatcher, InboundMessage } from '../../../core/channel-connector.js';

// processOneMessage 读取账号文件 / 出站临时目录，都走夹具注入的 Piskie 专属根
const storageFixture = createChannelStorageFixture('weixin-image-pipeline-');
storageFixture.bindAll();
afterAll(() => storageFixture.cleanup());

vi.mock('../vendor/src/auth/pairing.js', () => ({ readFrameworkAllowFromList: () => ['sender-1'], registerUserInFrameworkStore: vi.fn() }));
vi.mock('../vendor/src/messaging/debug-mode.js', () => ({ isDebugMode: () => false }));

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

it('preserves incoming image order and sends every tool image with the original Weixin context', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-image-test-'));
  directories.push(directory);
  const files = [path.join(directory, 'read.png'), path.join(directory, 'generated.png')];
  await Promise.all(files.map((file) => fs.writeFile(file, png)));
  const incoming: InboundMessage[] = [];
  let saved = 0;
  let retained: ReplyDispatcher | undefined;
  const host = new OpenClawRuntimeHost('openclaw-weixin');
  host.register({
    bot: { id: 'bot-1', name: 'Bot', channelType: 'openclaw-weixin' },
    signal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pairing: { getAllowedSenders: () => ['sender-1'] },
    media: { saveBuffer: async (buffer: Buffer) => {
      const file = path.join(directory, `incoming-${saved++}.png`);
      await fs.writeFile(file, buffer);
      return { path: file, size: buffer.length, contentType: 'image/png' };
    } },
    dispatchWithQueue: async (message: InboundMessage, queue: ReplyDispatcher) => {
      incoming.push(message);
      retained = queue;
      queue.sendToolResult({ mediaUrls: files });
      queue.markComplete();
      await queue.waitForIdle();
      return { kind: 'agent', completion: 'yield', counts: queue.getQueuedCounts() };
    },
  } as unknown as ConnectorContext);
  const sent: Array<{ msg: { to_user_id: string; context_token: string; item_list: Array<{ type: number }> } }> = [];
  const uploads: Buffer[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options?: RequestInit) => {
    const address = String(url);
    if (address.endsWith('/source-1') || address.endsWith('/source-2')) return new Response(png);
    if (address.includes('getuploadurl')) return Response.json({ upload_full_url: 'https://cdn.example.test/upload' });
    if (address.endsWith('/upload')) {
      uploads.push(Buffer.from(options!.body as Uint8Array));
      return new Response('', { headers: { 'x-encrypted-param': 'download-key' } });
    }
    if (address.includes('sendmessage')) {
      sent.push(JSON.parse(options!.body as string));
      return Response.json({ ret: 0 });
    }
    throw new Error(`Unexpected test request: ${address}`);
  }));
  const runtime = host.buildRuntime();
  await processOneMessage({
    from_user_id: 'sender-1', context_token: 'context-1',
    item_list: [1, 2].map((id) => ({ type: 2, image_item: { media: { full_url: `https://cdn.example.test/source-${id}` } } })),
  }, {
    accountId: 'bot-1', channelRuntime: runtime.channel, config: host.loadConfig(),
    baseUrl: 'https://chat.example.test/', cdnBaseUrl: 'https://cdn.example.test/', token: 'token',
    abortSignal: new AbortController().signal, log: vi.fn(), errLog: vi.fn(),
  });
  expect(incoming[0]?.media?.map((media) => path.basename(media.path))).toEqual(['incoming-0.png', 'incoming-1.png']);
  expect(uploads).toHaveLength(2);
  expect(uploads[0]).not.toEqual(png);
  expect(sent).toHaveLength(2);
  expect(sent.every((body) => body.msg.to_user_id === 'sender-1' && body.msg.context_token === 'context-1')).toBe(true);
  expect(sent.every((body) => body.msg.item_list.some((item: { type: number }) => item.type === 2))).toBe(true);
  retained!.sendToolResult({ mediaUrls: [files[0]!] });
  await retained!.waitForIdle();
  expect(sent).toHaveLength(3);
});
