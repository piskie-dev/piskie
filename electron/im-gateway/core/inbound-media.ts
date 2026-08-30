/**
 * 进站媒体校验与转换
 *
 * media 是一次调用内的运输输入，不是会话状态。核心语义：
 * - realpath 验证每个路径是受管目录（os.tmpdir()/piskie-media）内的普通文件
 * - stat 先查数量/单文件/总字节上限，超限不读完整文件
 * - 通过后读取并以文件 magic 检测真实 MIME（declaredMediaType 只作提示/诊断），
 *   只接受 image/png、image/jpeg、image/webp、image/gif
 * - 任一附件不合规 → 整条拒绝（不部分消费），回复明确且安全的固定文案
 * - 清理只删通过受管目录校验且属于本次消息的文件；越界路径绝不删除
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import type { InboundMediaFile } from './channel-connector.js';

export const MAX_IM_IMAGE_COUNT = 10;
export const MAX_IM_IMAGE_BYTES = 5 * 1024 * 1024; // 单张 5 MiB
export const MAX_IM_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024; // 单条消息 20 MiB

export const UNSUPPORTED_MEDIA_REPLY = '当前仅支持 PNG/JPEG/WEBP/GIF 图片，暂不支持该文件类型';
export const MEDIA_LIMIT_REPLY = `图片超出限制：单条消息最多 ${MAX_IM_IMAGE_COUNT} 张、单张不超过 5 MiB、合计不超过 20 MiB`;
export const MEDIA_READ_FAILED_REPLY = '媒体处理失败，请稍后重试';

/** 受管临时目录：渠道 saveBuffer 落盘与 Pipeline realpath 校验共用同一根 */
export function getManagedMediaDir(): string {
  const dir = path.join(os.tmpdir(), 'piskie-media');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export interface InboundImagePayload {
  data: string;
  media_type: string;
}

export type MediaConversionResult =
  | { ok: true; images: InboundImagePayload[] }
  | { ok: false; reason: 'unsupported' | 'limit' | 'read_failed'; reply: string };

type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** 文件 magic 检测（现有图片链路支持的四种类型），不信任 declaredMediaType */
function detectImageMime(buf: Buffer): SupportedImageMime | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 6) {
    const sig = buf.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  return null;
}

/** realpath 归一化后判断是否在受管目录内（防 symlink/`..` 越界） */
function isInsideManagedDir(managedRealRoot: string, realPath: string): boolean {
  const rel = path.relative(managedRealRoot, realPath);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** realpath + stat：受管目录内的普通文件才返回；越界/缺失/非普通文件返回 null */
async function resolveManagedFile(
  filePath: string
): Promise<{ realPath: string; size: number } | null> {
  const managedRealRoot = await fs.promises.realpath(getManagedMediaDir());
  const realPath = await fs.promises.realpath(filePath);
  if (!isInsideManagedDir(managedRealRoot, realPath)) return null;
  const st = await fs.promises.stat(realPath);
  if (!st.isFile()) return null;
  return { realPath, size: st.size };
}

export async function validateAndConvertInboundMedia(
  media: readonly InboundMediaFile[]
): Promise<MediaConversionResult> {
  if (media.length > MAX_IM_IMAGE_COUNT) {
    return { ok: false, reason: 'limit', reply: MEDIA_LIMIT_REPLY };
  }

  // 先 stat 全量校验大小（不读内容），任一超限整条拒绝
  const resolved: Array<{ realPath: string; size: number }> = [];
  let totalBytes = 0;
  for (const file of media) {
    let entry: { realPath: string; size: number } | null;
    try {
      entry = await resolveManagedFile(file.path);
    } catch {
      entry = null;
    }
    if (!entry) {
      return { ok: false, reason: 'read_failed', reply: MEDIA_READ_FAILED_REPLY };
    }
    if (entry.size > MAX_IM_IMAGE_BYTES) {
      return { ok: false, reason: 'limit', reply: MEDIA_LIMIT_REPLY };
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_IM_IMAGE_TOTAL_BYTES) {
      return { ok: false, reason: 'limit', reply: MEDIA_LIMIT_REPLY };
    }
    resolved.push(entry);
  }

  // 大小通过后按序读取 + magic 检测；任一非图片/未知格式整条拒绝
  const images: InboundImagePayload[] = [];
  for (let i = 0; i < resolved.length; i++) {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(resolved[i].realPath);
    } catch {
      return { ok: false, reason: 'read_failed', reply: MEDIA_READ_FAILED_REPLY };
    }
    const mime = detectImageMime(buf);
    if (!mime) {
      return { ok: false, reason: 'unsupported', reply: UNSUPPORTED_MEDIA_REPLY };
    }
    images.push({ data: buf.toString('base64'), media_type: mime });
  }

  return { ok: true, images };
}

/**
 * 逐个删除本次消息移交的受管临时文件（所有出口 finally 调用，幂等）。
 * 只删通过受管目录校验的文件；越界路径绝不删除；不递归清空共享目录。
 */
export async function cleanupInboundMedia(
  media: readonly InboundMediaFile[] | undefined
): Promise<void> {
  if (!media?.length) return;
  for (const file of media) {
    try {
      const managedRealRoot = await fs.promises.realpath(getManagedMediaDir());
      const realPath = await fs.promises.realpath(file.path);
      if (!isInsideManagedDir(managedRealRoot, realPath)) continue;
      await fs.promises.unlink(realPath);
    } catch {
      // 文件已删除/不存在：清理幂等，静默跳过
    }
  }
}
