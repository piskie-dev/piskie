import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendImageMessage } from '../qqbot/vendor/src/api.js';
import { uploadAndSendMedia } from '../wecom/vendor/media-uploader.js';
import { OpenClawRuntimeHost } from '../../core/openclaw-runtime-host.js';
import { sendImageBatch } from '../../core/media-io.js';

const require = createRequire(import.meta.url);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
async function imageFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'im-native-image-'));
  directories.push(directory);
  const file = path.join(directory, 'sample image.png');
  await fs.writeFile(file, png);
  return file;
}

describe('QQ native image delivery', () => {
  it.each(['c2c', 'group', 'guild', 'dm'])('uploads and sends an image to %s', async (type) => {
    const fetch = vi.fn(async (url: string) => Response.json(url.endsWith('/files')
      ? { file_info: 'uploaded-image' } : { id: 'sent-image' }));
    vi.stubGlobal('fetch', fetch);
    const target = { type, senderId: 'user-1', groupOpenid: 'group-1', channelId: 'channel-1', guildId: 'guild-1', messageId: 'message-1' };
    const file = await imageFile();
    await sendImageBatch([file], (_source, buffer) => sendImageMessage('token', target, buffer));
    const [url, options] = fetch.mock.calls.at(-1)! as unknown as [string, RequestInit];
    if (type === 'guild' || type === 'dm') {
      expect(url).toContain(type === 'dm' ? '/dms/guild-1/messages' : '/channels/channel-1/messages');
      const body = options.body as FormData;
      expect(body.get('msg_id')).toBe('message-1');
      expect(Buffer.from(await (body.get('file_image') as Blob).arrayBuffer())).toEqual(png);
      expect(options.headers).not.toHaveProperty('Content-Type');
    } else {
      const upload = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      expect(Buffer.from(upload.file_data, 'base64')).toEqual(png);
      expect(upload.srv_send_msg).toBe(false);
      expect(url).toContain(type === 'group' ? '/v2/groups/group-1/messages' : '/v2/users/user-1/messages');
      expect(JSON.parse(options.body as string)).toMatchObject({ msg_type: 7, media: { file_info: 'uploaded-image' }, msg_id: 'message-1' });
    }
  });

  it('does not begin a platform request after cancellation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(sendImageMessage('token', { type: 'c2c', senderId: 'user-1' }, png, controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('WeCom native image delivery', () => {
  it('sends both existing files as native images and propagates SDK failure', async () => {
    const file = await imageFile();
    const wsClient = {
      uploadMedia: vi.fn(async () => ({ media_id: 'media-1' })),
      sendMediaMessage: vi.fn(async () => ({ headers: { req_id: 'sent-1' } })),
    };
    await sendImageBatch([file, file], async (source, buffer) => {
      const result = await uploadAndSendMedia({ wsClient: wsClient as never, mediaUrl: source, chatId: 'chat-1' }, buffer);
      if (!result.ok) throw new Error(result.error);
    });
    expect(wsClient.uploadMedia).toHaveBeenCalledWith(png, expect.objectContaining({ type: 'image' }));
    expect(wsClient.sendMediaMessage).toHaveBeenNthCalledWith(2, 'chat-1', 'image', 'media-1');
    wsClient.uploadMedia.mockRejectedValueOnce(new Error('upload rejected'));
    const result = await uploadAndSendMedia({ wsClient: wsClient as never, mediaUrl: file, chatId: 'chat-1' }, png);
    expect(result.ok).toBe(false);
    expect(wsClient.sendMediaMessage).toHaveBeenCalledTimes(2);
  });

  it('checks cancellation again after the SDK upload', async () => {
    const controller = new AbortController();
    const wsClient = { uploadMedia: vi.fn(async () => { controller.abort(); return { media_id: 'media-1' }; }), sendMediaMessage: vi.fn() };
    const result = await uploadAndSendMedia({ wsClient: wsClient as never, mediaUrl: '/output/image.png', chatId: 'chat-1' }, png, controller.signal);
    expect(result.ok).toBe(false);
    expect(wsClient.sendMediaMessage).not.toHaveBeenCalled();
  });
});

describe('Feishu existing reply dispatcher', () => {
  it.each(['static', 'streaming'])('sends images before and after %s completion in the original thread', async (mode) => {
    const { LarkClient } = require('../feishu/vendor/src/core/lark-client.js');
    const controllers = require('../feishu/vendor/src/card/streaming-card-controller.js');
    const sdk = {
      im: {
        image: { create: vi.fn(async () => ({ data: { image_key: 'image-key' } })) },
        message: { reply: vi.fn(async () => ({ data: { message_id: 'message-image', chat_id: 'oc_chat' } })) },
      },
    };
    vi.spyOn(LarkClient, 'fromCfg').mockReturnValue({ sdk });
    vi.spyOn(controllers, 'StreamingCardController').mockImplementation(class {
      cardMessageId = 'card-1';
      isTerminated = false;
      isAborted = false;
      shouldSkipForUnavailable() { return false; }
      async ensureCardCreated() {}
      async onDeliver() {}
      markFullyComplete() {}
      async onIdle() {}
    });
    LarkClient.setRuntime(new OpenClawRuntimeHost('feishu').buildRuntime());
    const { createFeishuReplyDispatcher } = require('../feishu/vendor/src/card/reply-dispatcher.js');
    const result = createFeishuReplyDispatcher({
      cfg: { channels: { feishu: { appId: 'app-1', appSecret: 'secret', replyMode: mode } } },
      agentId: 'agent-1', sessionKey: 'session-1', chatId: 'oc_chat', accountId: 'default',
      replyToMessageId: 'thread-1', replyInThread: true, skipTyping: true,
    });
    const file = await imageFile();
    result.dispatcher.sendToolResult({ mediaUrls: [file, file] });
    result.dispatcher.markComplete();
    await result.dispatcher.waitForIdle();
    result.markFullyComplete();
    result.dispatcher.sendToolResult({ mediaUrls: [file] });
    await result.dispatcher.waitForIdle();
    expect(sdk.im.image.create).toHaveBeenCalledTimes(3);
    expect(sdk.im.message.reply).toHaveBeenCalledTimes(3);
    expect(sdk.im.message.reply).toHaveBeenLastCalledWith({
      path: { message_id: 'thread-1' },
      data: { content: JSON.stringify({ image_key: 'image-key' }), msg_type: 'image', reply_in_thread: true },
    }, expect.objectContaining({ timeout: 120_000 }));
  });
});
