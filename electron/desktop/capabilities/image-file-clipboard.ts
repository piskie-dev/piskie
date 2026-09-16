import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { clipboard } from 'electron';
import { load } from 'cheerio/slim';
import type { CopyImageRequest } from '../../../shared/electron-contracts/desktop.js';
import { inspectRasterImage, MAX_IMAGE_BYTES } from '../../../shared/utils/image-format.js';
import { PublicOperationError } from '../../capabilities/public-errors.js';

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg',
};
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Local files stay with their source owner; published temporary files use system cleanup. */
export async function copyImageFile(
  source: Exclude<CopyImageRequest, { kind: 'preview' }>,
  readLocalImage: (target: string) => Promise<{ path: string; bytes: Uint8Array }>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let filePath: string;
  if (source.kind === 'path') {
    const local = await readLocalImage(source.path);
    imageExtension(local.bytes);
    filePath = local.path;
  } else {
    const original = source.kind === 'bytes'
      ? { bytes: new Uint8Array(source.bytes), name: source.name }
      : await readRemoteImage(source.url, source.name, signal);
    const extension = imageExtension(original.bytes);
    signal?.throwIfAborted();
    const root = path.join(os.tmpdir(), 'piskie', 'clipboard');
    await fs.promises.mkdir(root, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(root, 'image-'));
    filePath = path.join(directory, imageFileName(original.name, extension));
    await fs.promises.writeFile(filePath, original.bytes, { flag: 'wx', signal });
  }
  signal?.throwIfAborted();
  await publishImageFile(filePath, signal);
}

function imageExtension(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw imageTooLarge();
  try {
    return IMAGE_EXTENSIONS[inspectRasterImage(bytes).mediaType]!;
  } catch {
    // SVG is inspected as XML only; file copying never renders or evaluates its contents.
    const xml = new TextDecoder().decode(bytes);
    const root = load(xml, { xmlMode: true }).root().children();
    if (root.length === 1 && root[0]?.tagName === 'svg') return '.svg';
    throw new PublicOperationError('invalid-input', 'The source is not a supported image');
  }
}

function imageFileName(name: string | undefined, extension: string): string {
  const leaf = (name ?? 'image').split(/[\\/]/).pop() ?? 'image';
  // Control characters and Windows filename separators are not usable in a published filename.
  // eslint-disable-next-line no-control-regex
  const clean = leaf.replace(/\.[^.]*$/, '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '');
  const stem = Array.from(clean).slice(0, 60).join('');
  const usable = !stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? 'image' : stem;
  const originalExtension = path.extname(leaf);
  const suffix = originalExtension.toLowerCase() === extension
    || (extension === '.jpg' && originalExtension.toLowerCase() === '.jpeg') ? originalExtension : extension;
  return `${usable}${suffix}`;
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

async function readRemoteImage(rawUrl: string, name: string | undefined, signal?: AbortSignal): Promise<{ bytes: Buffer; name: string }> {
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
    let urlName = path.posix.basename(url.pathname);
    try { urlName = decodeURIComponent(urlName); } catch { /* Keep the URL's encoded name. */ }
    return { bytes: Buffer.concat(chunks, size), name: name ?? urlName };
  }
}

function imageTooLarge(): PublicOperationError {
  return new PublicOperationError('invalid-input', 'The image exceeds the 32 MiB copy limit');
}

const WINDOWS_FILE_DROP_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($path)
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
`;

/** All native file clipboard formats and platform helpers are kept at this boundary. */
export async function publishImageFile(filePath: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const child = execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
        Buffer.from(WINDOWS_FILE_DROP_SCRIPT, 'utf16le').toString('base64'),
      ], { windowsHide: true, signal }, (error) => {
        if (error) reject(error);
        else resolve();
      });
      child.stdin!.on('error', reject);
      child.stdin!.end(Buffer.from(filePath, 'utf8').toString('base64'));
    });
    return;
  }
  const format = process.platform === 'linux' ? 'text/uri-list'
    : process.platform === 'darwin' ? 'public.file-url' : undefined;
  if (!format) throw new PublicOperationError('unavailable', 'File clipboard copying is unavailable on this platform');
  const value = Buffer.from(pathToFileURL(filePath).href + (process.platform === 'linux' ? '\r\n' : ''));
  clipboard.writeBuffer(format, value);
  if (!clipboard.readBuffer(format).equals(value)) {
    throw new PublicOperationError('unavailable', 'The system clipboard did not accept the image file');
  }
}
