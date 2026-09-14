import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_IM_IMAGE_BYTES,
  MAX_IM_IMAGE_COUNT,
  MAX_IM_IMAGE_TOTAL_BYTES,
  MEDIA_LIMIT_REPLY,
  detectImageMime,
  readMediaFile as readLocalMediaFile,
} from './inbound-media.js';

export function localMediaPath(source: string): string {
  return source.startsWith('file://') ? fileURLToPath(source) : source;
}

export async function readMediaFile(
  source: string,
  maxBytes = MAX_IM_IMAGE_BYTES,
  signal?: AbortSignal,
): Promise<Buffer> {
  return readLocalMediaFile(localMediaPath(source), maxBytes, signal);
}

export async function readMediaResponse(
  response: Response,
  maxBytes = MAX_IM_IMAGE_BYTES,
): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`媒体下载失败（HTTP ${response.status}）`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('媒体下载为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error(MEDIA_LIMIT_REPLY);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(MEDIA_LIMIT_REPLY);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function downloadMediaBytes(
  url: string,
  signal?: AbortSignal,
  maxBytes = MAX_IM_IMAGE_BYTES,
): Promise<Buffer> {
  const timeout = AbortSignal.timeout(120_000);
  return readMediaResponse(await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }), maxBytes);
}

export async function readOutboundImage(source: string, signal?: AbortSignal): Promise<Buffer> {
  const buffer = /^https?:\/\//.test(source)
    ? await downloadMediaBytes(source, signal)
    : await readMediaFile(source, MAX_IM_IMAGE_BYTES, signal);
  if (!detectImageMime(buffer)) throw new Error('图片读取失败：文件不是支持的图片格式');
  return buffer;
}

/** Preflight the existing file references; individual missing files are reported during delivery. */
export async function checkImageBudget(sources: readonly string[]): Promise<void> {
  if (sources.length > MAX_IM_IMAGE_COUNT) throw new Error(MEDIA_LIMIT_REPLY);
  let total = 0;
  for (const source of sources) {
    if (/^https?:\/\//.test(source)) continue;
    const stat = await fs.promises.stat(localMediaPath(source)).catch(() => undefined);
    if (!stat) continue;
    total += stat.size;
    if (stat.size > MAX_IM_IMAGE_BYTES || total > MAX_IM_IMAGE_TOTAL_BYTES) {
      throw new Error(MEDIA_LIMIT_REPLY);
    }
  }
}

/** Uses the caller's existing delivery task; returns only after every attempted send settles. */
export async function sendImageBatch(
  sources: readonly string[],
  send: (source: string, buffer: Buffer, index: number) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await checkImageBudget(sources);
  const errors: Error[] = [];
  let totalBytes = 0;
  for (let index = 0; index < sources.length; index++) {
    signal?.throwIfAborted();
    let stage = '读取';
    try {
      const buffer = await readOutboundImage(sources[index], signal);
      totalBytes += buffer.length;
      if (totalBytes > MAX_IM_IMAGE_TOTAL_BYTES) throw new Error(MEDIA_LIMIT_REPLY);
      signal?.throwIfAborted();
      stage = '上传或发送';
      await send(sources[index], buffer, index);
    } catch (cause) {
      signal?.throwIfAborted();
      const unconfirmed = stage === '上传或发送' && cause instanceof Error
        && /timeout|timed out|超时/i.test(`${cause.name} ${cause.message}`);
      const oversized = cause instanceof Error && cause.message === MEDIA_LIMIT_REPLY;
      const reason = unconfirmed ? '结果未确认（请求超时）' : `${stage}失败${oversized ? '（图片超出大小限制）' : ''}`;
      errors.push(new Error(`第 ${index + 1} 张图片${reason}`, { cause }));
    }
  }
  if (errors.length) {
    const summary = `图片发送：${sources.length - errors.length} 张成功，${errors.length} 张失败或未确认。`;
    throw new AggregateError(errors, `${summary}${errors.map((error) => error.message).join('；')}。`);
  }
}

/** Safe user notice: transport errors may contain request URLs or credentials. */
export function imageDeliveryErrorText(error: unknown): string {
  if (error instanceof AggregateError || (error instanceof Error && error.message === MEDIA_LIMIT_REPLY)) {
    return error.message;
  }
  return '图片或消息发送失败，请稍后重试。';
}
