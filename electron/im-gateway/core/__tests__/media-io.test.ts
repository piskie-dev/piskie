import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_IM_IMAGE_BYTES } from '../inbound-media.js';
import { readMediaResponse, sendImageBatch } from '../media-io.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
async function images() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'im-image-test-'));
  directories.push(directory);
  const files = ['first.png', 'second.png', 'third.png'].map((name) => path.join(directory, name));
  await Promise.all(files.map((file) => fs.writeFile(file, png)));
  return files;
}

describe('image transport IO', () => {
  it('sends images in order, continues after a failed upload, and keeps source files', async () => {
    const files = await images();
    const send = vi.fn(async (_source: string, buffer: Buffer, index: number) => {
      expect(buffer).toEqual(png);
      if (index === 1) throw new Error('platform rejected image');
    });
    await expect(sendImageBatch(files, send)).rejects.toThrow('2 张成功，1 张失败');
    expect(send.mock.calls.map(([source]) => source)).toEqual(files);
    expect(await fs.readFile(files[0]!)).toEqual(png);
  });

  it('rejects a batch exceeding the image budget before any upload', async () => {
    const files = await images();
    await fs.truncate(files[2]!, MAX_IM_IMAGE_BYTES + 1);
    const send = vi.fn();
    await expect(sendImageBatch(files, send)).rejects.toThrow('图片超出限制');
    expect(send).not.toHaveBeenCalled();
  });

  it('stops subsequent uploads after cancellation', async () => {
    const files = await images();
    const controller = new AbortController();
    const send = vi.fn(async () => controller.abort());
    await expect(sendImageBatch(files, send, controller.signal)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  it('cancels a response exceeding the byte budget even without content-length', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(6)); }, cancel,
    }));
    await expect(readMediaResponse(response, 10)).rejects.toThrow('图片超出限制');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('distinguishes unreadable files, rejected requests and unconfirmed timeouts', async () => {
    const files = await images();
    await fs.unlink(files[0]!);
    const send = vi.fn(async (_source: string, _buffer: Buffer, index: number) => {
      if (index === 1) throw new Error('platform rejected');
      throw new DOMException('request timed out', 'TimeoutError');
    });
    const error = await sendImageBatch(files, send).catch((error: AggregateError) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain('第 1 张图片读取失败');
    expect((error as AggregateError).message).toContain('第 2 张图片上传或发送失败');
    expect((error as AggregateError).message).toContain('第 3 张图片结果未确认');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
