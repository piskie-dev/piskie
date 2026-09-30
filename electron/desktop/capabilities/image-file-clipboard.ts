import { Readable } from 'node:stream';
import { clipboard } from 'electron';
import { load } from 'cheerio/slim';
import type { CopyImageRequest } from '../../../shared/electron-contracts/desktop.js';
import { inspectRasterImage, MAX_IMAGE_BYTES } from '../../../shared/utils/image-format.js';
import { PublicOperationError } from '../../capabilities/public-errors.js';
import { decodeClipboardImage } from './image-clipboard-decoder.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Reads the original source and publishes decoded pixels through Electron's native clipboard. */
export async function copyImageContents(
  source: Exclude<CopyImageRequest, { kind: 'preview' }>,
  readLocalImage: (target: string) => Promise<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const bytes = source.kind === 'path' ? await readLocalImage(source.path)
    : source.kind === 'bytes' ? new Uint8Array(source.bytes)
      : await readRemoteImage(source.url, signal);
  signal?.throwIfAborted();
  const image = await decodeClipboardImage(bytes, imageMediaType(bytes), signal);
  signal?.throwIfAborted();
  if (image.isEmpty()) throw new PublicOperationError('invalid-input', 'The source image could not be decoded');
  clipboard.writeImage(image);
  const published = clipboard.readImage();
  const expected = image.getSize();
  const actual = published.getSize();
  if (published.isEmpty() || actual.width !== expected.width || actual.height !== expected.height) {
    throw new PublicOperationError('unavailable', 'The system clipboard did not accept the image');
  }
}

function imageMediaType(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw imageTooLarge();
  try {
    return inspectRasterImage(bytes).mediaType;
  } catch {
    const xml = new TextDecoder().decode(bytes);
    const root = load(xml, { xmlMode: true }).root().children();
    if (root.length === 1 && root[0]?.tagName === 'svg') return 'image/svg+xml';
    throw new PublicOperationError('invalid-input', 'The source is not a supported image');
  }
}

function httpUrl(raw: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(raw, base); } catch {
    throw new PublicOperationError('invalid-input', 'The image URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicOperationError('invalid-input', 'Image downloads require HTTP or HTTPS');
  }
  return url;
}

async function readRemoteImage(rawUrl: string, signal?: AbortSignal): Promise<Buffer> {
  let url = httpUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    signal?.throwIfAborted();
    const response = await fetch(url.href, { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects >= 20) throw new PublicOperationError('unavailable', 'The image download could not follow its redirects');
      url = httpUrl(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new PublicOperationError('unavailable', `The image download failed (HTTP ${response.status})`);
    }
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      await response.body.cancel();
      throw imageTooLarge();
    }
    const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0], { signal });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw imageTooLarge();
      chunks.push(chunk as Buffer);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, size);
  }
}

function imageTooLarge(): PublicOperationError {
  return new PublicOperationError('invalid-input', 'The image exceeds the 32 MiB copy limit');
}
