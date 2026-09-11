import { attachmentError, IMAGE_LIMITS, inspectImage } from './image-format';

export function readImageBytes(blob: Blob, signal: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const reader = new FileReader();
    const finish = () => {
      signal.removeEventListener('abort', abort);
      reader.onload = reader.onerror = reader.onabort = null;
    };
    const abort = () => reader.abort();
    reader.onerror = () => { finish(); reject(attachmentError('capture')); };
    reader.onabort = () => { finish(); reject(signal.reason ?? attachmentError('capture')); };
    reader.onload = () => {
      const result = reader.result;
      finish();
      if (result && typeof result !== 'string') resolve(result);
      else reject(attachmentError('capture'));
    };
    signal.addEventListener('abort', abort, { once: true });
    try { reader.readAsArrayBuffer(blob); } catch (error) { finish(); reject(error); }
  });
}

function stableImage(buffer: ArrayBuffer): Blob {
  if (buffer.byteLength > IMAGE_LIMITS.imageBytes) throw attachmentError('imageBytes', { bytes: buffer.byteLength });
  const { mediaType } = inspectImage(new Uint8Array(buffer));
  return new Blob([buffer], { type: mediaType });
}

/** Calling this function starts the FileReader synchronously, before returning its promise. */
export async function captureFile(file: File, signal: AbortSignal): Promise<Blob> {
  const buffer = await readImageBytes(file, signal);
  signal.throwIfAborted();
  return stableImage(buffer);
}

/** A source URL is used only for this bounded capture, never for a ready draft. */
export async function captureSource(url: string, limit: number, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok || !response.body) throw attachmentError('capture');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw limit < IMAGE_LIMITS.imageBytes
        ? attachmentError('batchBytes') : attachmentError('imageBytes', { bytes: size });
      chunks.push(value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    chunks.length = 0;
    return stableImage(buffer.buffer);
  } finally {
    chunks.length = 0;
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
