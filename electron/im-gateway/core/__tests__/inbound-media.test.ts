import { createUuid } from '@shared/utils/identifiers.js';
/**
 * 进站媒体校验、magic 检测、上限与受管清理
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';



import {
  MAX_IM_IMAGE_COUNT,
  MAX_IM_IMAGE_BYTES,
  MAX_IM_IMAGE_TOTAL_BYTES,
  UNSUPPORTED_MEDIA_REPLY,
  MEDIA_LIMIT_REPLY,
  MEDIA_READ_FAILED_REPLY,
  getManagedMediaDir,
  validateAndConvertInboundMedia,
  cleanupInboundMedia,
} from '../inbound-media.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_MAGIC = Buffer.from('GIF89a');
const WEBP_MAGIC = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);

const createdPaths: string[] = [];

function writeManaged(content: Buffer): string {
  const p = path.join(getManagedMediaDir(), `test-${createUuid()}.bin`);
  fs.writeFileSync(p, content);
  createdPaths.push(p);
  return p;
}

function pngOfSize(size: number): Buffer {
  const buf = Buffer.alloc(size);
  PNG_MAGIC.copy(buf);
  return buf;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  for (const p of createdPaths) {
    try { fs.unlinkSync(p); } catch { /* 已删 */ }
  }
});

describe('validateAndConvertInboundMedia', () => {
  it('PNG/JPEG/WEBP/GIF 按序转换为 base64 + magic MIME', async () => {
    const files = [PNG_MAGIC, JPEG_MAGIC, WEBP_MAGIC, GIF_MAGIC].map(b => ({ path: writeManaged(b) }));
    const result = await validateAndConvertInboundMedia(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images.map(i => i.media_type)).toEqual([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    ]);
    expect(result.images[0].data).toBe(PNG_MAGIC.toString('base64'));
  });

  it('magic 优先于 declaredMediaType：声明 image/png 的 SVG 仍整条拒绝', async () => {
    const svg = writeManaged(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    const result = await validateAndConvertInboundMedia([
      { path: svg, declaredMediaType: 'image/png' },
    ]);
    expect(result).toEqual({ ok: false, reason: 'unsupported', reply: UNSUPPORTED_MEDIA_REPLY });
  });

  it('图片与不支持附件并存 → 整条拒绝不部分消费', async () => {
    const good = writeManaged(PNG_MAGIC);
    const bad = writeManaged(Buffer.from('%PDF-1.7 ...'));
    const result = await validateAndConvertInboundMedia([{ path: good }, { path: bad }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported');
  });

  it(`${MAX_IM_IMAGE_COUNT + 1} 张在读取前整条拒绝（固定限制文案）`, async () => {
    const files = Array.from({ length: MAX_IM_IMAGE_COUNT + 1 }, () => ({ path: '/nonexistent' }));
    const result = await validateAndConvertInboundMedia(files);
    expect(result).toEqual({ ok: false, reason: 'limit', reply: MEDIA_LIMIT_REPLY });
  });

  it('单张超 5 MiB 拒绝，恰好 5 MiB 边界接受', async () => {
    const over = writeManaged(pngOfSize(MAX_IM_IMAGE_BYTES + 1));
    expect(await validateAndConvertInboundMedia([{ path: over }])).toEqual({
      ok: false, reason: 'limit', reply: MEDIA_LIMIT_REPLY,
    });

    const exact = writeManaged(pngOfSize(MAX_IM_IMAGE_BYTES));
    const okResult = await validateAndConvertInboundMedia([{ path: exact }]);
    expect(okResult.ok).toBe(true);
  });

  it('总量超 20 MiB 在 stat 阶段拒绝，恰好 20 MiB 接受', async () => {
    // 4 张恰好 5 MiB = 20 MiB → 接受
    const four = Array.from({ length: 4 }, () => ({ path: writeManaged(pngOfSize(MAX_IM_IMAGE_BYTES)) }));
    expect(MAX_IM_IMAGE_BYTES * 4).toBe(MAX_IM_IMAGE_TOTAL_BYTES);
    const okResult = await validateAndConvertInboundMedia(four);
    expect(okResult.ok).toBe(true);

    // 再加 1 字节的第五张 → 超总量拒绝
    const five = [...four, { path: writeManaged(pngOfSize(1024)) }];
    expect(await validateAndConvertInboundMedia(five)).toEqual({
      ok: false, reason: 'limit', reply: MEDIA_LIMIT_REPLY,
    });
  });

  it('越出受管目录的路径拒绝读取（read_failed，不读文件内容）', async () => {
    const outside = path.join(os.tmpdir(), `outside-${createUuid()}.png`);
    fs.writeFileSync(outside, PNG_MAGIC);
    try {
      const result = await validateAndConvertInboundMedia([{ path: outside }]);
      expect(result).toEqual({ ok: false, reason: 'read_failed', reply: MEDIA_READ_FAILED_REPLY });
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it('文件不存在 → read_failed 安全文案', async () => {
    const result = await validateAndConvertInboundMedia([
      { path: path.join(getManagedMediaDir(), 'missing.png') },
    ]);
    expect(result).toEqual({ ok: false, reason: 'read_failed', reply: MEDIA_READ_FAILED_REPLY });
  });

  it('download-failed:// 哨兵路径（渠道下载失败上报）→ read_failed 整条明确失败，不伪装成无附件文本', async () => {
    const good = writeManaged(PNG_MAGIC);
    const result = await validateAndConvertInboundMedia([
      { path: good },
      { path: 'download-failed://cdn.example/file.pdf', declaredMediaType: 'application/octet-stream' },
    ]);
    expect(result).toEqual({ ok: false, reason: 'read_failed', reply: MEDIA_READ_FAILED_REPLY });
  });
});

describe('cleanupInboundMedia', () => {
  it('删除本次消息的受管文件，幂等（重复清理/文件缺失不抛）', async () => {
    const p1 = writeManaged(PNG_MAGIC);
    const p2 = writeManaged(JPEG_MAGIC);
    await cleanupInboundMedia([{ path: p1 }, { path: p2 }]);
    expect(fs.existsSync(p1)).toBe(false);
    expect(fs.existsSync(p2)).toBe(false);
    await expect(cleanupInboundMedia([{ path: p1 }, { path: p2 }])).resolves.toBeUndefined();
  });

  it('越界路径绝不删除', async () => {
    const outside = path.join(os.tmpdir(), `outside-${createUuid()}.png`);
    fs.writeFileSync(outside, PNG_MAGIC);
    try {
      await cleanupInboundMedia([{ path: outside }]);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it('不删除其他消息的文件：只处理传入清单', async () => {
    const mine = writeManaged(PNG_MAGIC);
    const other = writeManaged(GIF_MAGIC);
    await cleanupInboundMedia([{ path: mine }]);
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('undefined/空清单 no-op', async () => {
    await expect(cleanupInboundMedia(undefined)).resolves.toBeUndefined();
    await expect(cleanupInboundMedia([])).resolves.toBeUndefined();
  });
});
