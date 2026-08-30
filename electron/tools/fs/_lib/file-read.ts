import * as fs from 'node:fs/promises';
import type { FileGuardPort, VersionToken } from '../../types.js';
import { detectTextEncoding, type TextEncoding } from './encoding.js';
import { isNotFound, sameVersion, tokenFromStat } from '../../state/read-ledger.js';

export type VersionedRead =
  | { kind: 'read'; text: string; stable: boolean }
  | { kind: 'missing' };

/** Read and version the same open file descriptor, never a later path lookup. */
export async function readTextWithVersion(
  canonicalPath: string,
  files: FileGuardPort,
): Promise<VersionedRead> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(canonicalPath, 'r');
  } catch (error) {
    if (!isNotFound(error)) throw error;
    files.forget(canonicalPath);
    return { kind: 'missing' };
  }

  try {
    const before = tokenFromStat(await handle.stat({ bigint: true }));
    const text = await handle.readFile({ encoding: 'utf8' });
    const after = tokenFromStat(await handle.stat({ bigint: true }));
    const stable = sameVersion(before, after);
    if (stable) files.record(canonicalPath, before, 'read');
    return { kind: 'read', text, stable };
  } finally {
    await handle.close();
  }
}

export type TextRangeRead =
  | { kind: 'missing' }
  | {
      kind: 'read';
      lines: readonly string[];
      startLine: number;
      endLine: number;
      totalLines: number;
      nextOffset?: number;
      overlongLine?: number;
      stable: boolean;
      encoding: TextEncoding;
      token: VersionToken;
    };

export type BufferRead =
  | { kind: 'missing' }
  | { kind: 'tooLarge'; bytes: number }
  | {
      kind: 'read';
      buffer: Buffer;
      stable: boolean;
      token: VersionToken;
    };

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads a bounded line range while scanning the file with fixed memory. The
 * full scan is needed only to report an honest total line count.
 */
export async function readTextRangeWithVersion(
  canonicalPath: string,
  files: FileGuardPort,
  options: { offset: number; limit: number; byteBudget: number },
): Promise<TextRangeRead> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(canonicalPath, 'r');
  } catch (error) {
    if (!isNotFound(error)) throw error;
    files.forget(canonicalPath);
    return { kind: 'missing' };
  }

  try {
    const before = tokenFromStat(await handle.stat({ bigint: true }));
    const header = Buffer.alloc(4);
    const headerRead = await handle.read(header, 0, header.length, 0);
    const encoding = detectTextEncoding(header.subarray(0, headerRead.bytesRead));
    const bomBytes = encoding === 'utf8-bom' ? 3 : encoding === 'utf8' ? 0 : 2;
    const decoder = new TextDecoder(decoderLabel(encoding));
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);

    let position = bomBytes;
    let lineNumber = 1;
    let sawContent = false;
    let lineHasContent = false;
    let current = '';
    let currentBytes = 0;
    let currentOverflow = false;
    let usedBytes = 0;
    let stopped = false;
    let nextOffset: number | undefined;
    let overlongLine: number | undefined;
    const lines: string[] = [];

    const shouldCapture = (): boolean => (
      !stopped
      && lineNumber >= options.offset
      && lines.length < options.limit
    );

    const append = (fragment: string): void => {
      if (fragment.length === 0) return;
      sawContent = true;
      lineHasContent = true;
      if (!shouldCapture() || currentOverflow) return;

      const remaining = Math.max(0, options.byteBudget - usedBytes - currentBytes);
      const encoded = Buffer.from(fragment, 'utf8');
      if (encoded.length <= remaining) {
        current += fragment;
        currentBytes += encoded.length;
        return;
      }

      if (remaining > 0) {
        const prefix = utf8Prefix(fragment, remaining);
        current += prefix;
        currentBytes += Buffer.byteLength(prefix, 'utf8');
      }
      currentOverflow = true;
    };

    const finishLine = (): void => {
      if (shouldCapture()) {
        if (currentOverflow) {
          if (lines.length === 0) {
            lines.push(stripTrailingCarriageReturn(current));
            usedBytes += currentBytes;
            overlongLine = lineNumber;
          } else {
            nextOffset = lineNumber;
          }
          stopped = true;
        } else {
          const rendered = stripTrailingCarriageReturn(current);
          lines.push(rendered);
          usedBytes += Buffer.byteLength(rendered, 'utf8') + 1;
          if (lines.length >= options.limit || usedBytes >= options.byteBudget) {
            nextOffset = lineNumber + 1;
            stopped = true;
          }
        }
      }
      current = '';
      currentBytes = 0;
      currentOverflow = false;
      lineHasContent = false;
      lineNumber++;
    };

    const consume = (decoded: string): void => {
      let start = 0;
      for (let index = 0; index < decoded.length; index++) {
        if (decoded.charCodeAt(index) !== 10) continue;
        append(decoded.slice(start, index));
        finishLine();
        start = index + 1;
      }
      append(decoded.slice(start));
    };

    for (;;) {
      const read = await handle.read(chunk, 0, chunk.length, position);
      if (read.bytesRead === 0) break;
      sawContent = true;
      position += read.bytesRead;
      consume(decoder.decode(chunk.subarray(0, read.bytesRead), { stream: true }));
    }
    consume(decoder.decode());
    if (lineHasContent) finishLine();

    const totalLines = sawContent ? lineNumber - 1 : 0;
    if (nextOffset !== undefined && nextOffset > totalLines) nextOffset = undefined;

    const after = tokenFromStat(await handle.stat({ bigint: true }));
    const stable = sameVersion(before, after);
    if (stable) files.record(canonicalPath, before, 'read');

    return {
      kind: 'read',
      lines: Object.freeze(lines),
      startLine: options.offset,
      endLine: lines.length > 0 ? options.offset + lines.length - 1 : options.offset - 1,
      totalLines,
      nextOffset,
      overlongLine,
      stable,
      encoding,
      token: before,
    };
  } finally {
    await handle.close();
  }
}

/** Reads a bounded whole file and versions exactly the opened inode. */
export async function readBufferWithVersion(
  canonicalPath: string,
  files: FileGuardPort,
  maxBytes: number,
): Promise<BufferRead> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(canonicalPath, 'r');
  } catch (error) {
    if (!isNotFound(error)) throw error;
    files.forget(canonicalPath);
    return { kind: 'missing' };
  }

  try {
    const before = tokenFromStat(await handle.stat({ bigint: true }));
    if (before.size > BigInt(maxBytes)) {
      return { kind: 'tooLarge', bytes: Number(before.size) };
    }
    const buffer = await readAtMost(handle, maxBytes + 1);
    const after = tokenFromStat(await handle.stat({ bigint: true }));
    if (buffer.length > maxBytes || after.size > BigInt(maxBytes)) {
      return {
        kind: 'tooLarge',
        bytes: Math.max(buffer.length, Number(after.size)),
      };
    }
    const stable = sameVersion(before, after);
    if (stable) files.record(canonicalPath, before, 'read');
    return { kind: 'read', buffer, stable, token: before };
  } finally {
    await handle.close();
  }
}

/** Samples an opened inode for binary controls; it never records a partial read. */
export async function looksBinaryFile(
  canonicalPath: string,
): Promise<boolean | 'missing'> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(canonicalPath, 'r');
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    throw error;
  }

  try {
    const sample = await readAtMost(handle, 8 * 1024);
    if (sample.length >= 2 && (
      (sample[0] === 0xff && sample[1] === 0xfe)
      || (sample[0] === 0xfe && sample[1] === 0xff)
    )) return false;
    let controls = 0;
    for (const byte of sample) {
      if (byte === 0) return true;
      if (byte < 9 || (byte > 13 && byte < 32)) controls++;
    }
    return sample.length > 0 && controls / sample.length > 0.1;
  } finally {
    await handle.close();
  }
}

async function readAtMost(handle: fs.FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function decoderLabel(encoding: TextEncoding): 'utf-8' | 'utf-16le' | 'utf-16be' {
  if (encoding === 'utf16le') return 'utf-16le';
  if (encoding === 'utf16be') return 'utf-16be';
  return 'utf-8';
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let used = 0;
  let result = '';
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}
