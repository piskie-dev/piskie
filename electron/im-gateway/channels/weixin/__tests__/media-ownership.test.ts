import { createUuid } from '@shared/utils/identifiers.js';
/**
 * Weixin pre-dispatch 媒体所有权
 *
 * 已下载落盘的入站媒体在未调用 dispatch 的出口（准入拒绝等）由 Connector
 * 本地清理：cleanupDownloadedMediaOpts 删除四类落盘路径、跳过
 * download-failed:// 哨兵、幂等。
 */

import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import { cleanupDownloadedMediaOpts } from '../vendor/src/messaging/process-message.js';

function tmpFile(): string {
  const p = path.join(os.tmpdir(), `weixin-media-${createUuid()}.bin`);
  fs.writeFileSync(p, Buffer.from('x'));
  return p;
}

describe('cleanupDownloadedMediaOpts', () => {
  it('删除全部四类已落盘媒体（图片/语音/文件/视频）', () => {
    const pic = tmpFile();
    const voice = tmpFile();
    const file = tmpFile();
    const video = tmpFile();

    cleanupDownloadedMediaOpts({
      decryptedPicPath: pic,
      decryptedVoicePath: voice,
      decryptedFilePath: file,
      decryptedVideoPath: video,
    });

    expect(fs.existsSync(pic)).toBe(false);
    expect(fs.existsSync(voice)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(video)).toBe(false);
  });

  it('download-failed:// 哨兵非真实路径，跳过不抛', () => {
    expect(() => cleanupDownloadedMediaOpts({
      decryptedPicPath: 'download-failed://inbound-image',
    })).not.toThrow();
  });

  it('幂等：路径缺失/文件不存在/空对象均静默', () => {
    const gone = path.join(os.tmpdir(), `weixin-media-${createUuid()}.bin`);
    expect(() => cleanupDownloadedMediaOpts({ decryptedPicPath: gone })).not.toThrow();
    expect(() => cleanupDownloadedMediaOpts({})).not.toThrow();
    expect(() => cleanupDownloadedMediaOpts(undefined)).not.toThrow();
  });
});
