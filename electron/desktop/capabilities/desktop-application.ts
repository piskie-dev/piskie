import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipboard, net, shell } from 'electron';
import type {
  ClipboardAttachmentDescriptor,
  DesktopColorScheme,
  FilePreviewDescriptor,
} from '../../../shared/electron-contracts/desktop.js';
import type {
  DesktopAppearancePort,
  DesktopPresentationPort,
} from '../desktop-presentation-port.js';
import type { ThemeService } from '../../services/theme.service.js';
import { PublicOperationError } from '../../capabilities/public-errors.js';

const IMAGE_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
});
const BINARY_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.sqlite': 'application/vnd.sqlite3',
  '.db': 'application/octet-stream',
});
const MAX_TEXT_PREVIEW_BYTES = 384 * 1024;
const BINARY_SAMPLE_BYTES = 8 * 1024;
const MAX_CLIPBOARD_ATTACHMENTS = 32;
const MAX_CLIPBOARD_FORMAT_BYTES = 256 * 1024;

export class DesktopApplication {
  constructor(private readonly dependencies: {
    name: string;
    version: string;
    userDataDirectory: string;
    development: boolean;
    presentation: DesktopPresentationPort;
    appearance: DesktopAppearancePort;
    theme: ThemeService;
  }) {}

  info(): { name: string; version: string } {
    return {
      name: this.dependencies.name,
      version: this.dependencies.version,
    };
  }

  openDevTools(windowId: number): void {
    if (!this.dependencies.development) {
      throw new PublicOperationError('forbidden', 'Developer tools are disabled');
    }
    this.dependencies.presentation.openDevTools(windowId);
  }

  async openExternal(rawUrl: string): Promise<void> {
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      throw new PublicOperationError('invalid-input', 'The external URL is invalid');
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new PublicOperationError('forbidden', 'The external URL scheme is not allowed');
    }
    if (target.username || target.password) {
      throw new PublicOperationError('forbidden', 'External URL credentials are not allowed');
    }
    await shell.openExternal(target.toString(), { activate: true });
  }

  async openPath(targetPath: string): Promise<void> {
    const safePath = this.requireExistingPath(targetPath);
    const result = await Promise.race([
      shell.openPath(safePath),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ]);
    if (result) throw new PublicOperationError('unavailable', 'The path could not be opened');
  }

  revealPath(targetPath: string): void {
    const safePath = this.requireExistingPath(targetPath);
    shell.showItemInFolder(safePath);
  }

  openWorkspace(workspace?: string): Promise<void> {
    return this.openPath(
      workspace ?? path.join(this.dependencies.userDataDirectory, 'workspace'),
    );
  }

  openAgentRunTrace(agentId: string): Promise<void> {
    return this.openPath(path.join(
      this.dependencies.userDataDirectory,
      'agent-runs',
      agentId,
      'trace.md',
    ));
  }

  async clipboardAttachments(windowId: number): Promise<ClipboardAttachmentDescriptor[]> {
    const candidates = readClipboardPathCandidates().slice(0, MAX_CLIPBOARD_ATTACHMENTS);
    const described = await Promise.all(candidates.map(async (candidate) => {
      try {
        const file = await resolveRegularFile(candidate);
        const mediaType = IMAGE_MIME[path.extname(file.path).toLowerCase()];
        return {
          name: path.basename(file.path),
          path: file.path,
          size: file.size,
          ...(mediaType && {
            mediaType,
            previewUrl: this.dependencies.presentation.createFilePreviewUrl(
              windowId,
              file.path,
              mediaType,
            ),
          }),
        } satisfies ClipboardAttachmentDescriptor;
      } catch {
        return undefined;
      }
    }));

    const unique = new Map<string, ClipboardAttachmentDescriptor>();
    for (const descriptor of described) {
      if (descriptor) unique.set(descriptor.path, descriptor);
    }
    return [...unique.values()];
  }

  async previewFile(windowId: number, targetPath: string): Promise<FilePreviewDescriptor> {
    const file = await resolveRegularFile(targetPath);
    const extension = path.extname(file.path).toLowerCase();
    const imageMediaType = IMAGE_MIME[extension];
    if (imageMediaType) {
      return {
        kind: 'image',
        url: this.dependencies.presentation.createFilePreviewUrl(
          windowId,
          file.path,
          imageMediaType,
        ),
        mediaType: imageMediaType,
        size: file.size,
      };
    }

    const binaryMediaType = BINARY_MIME[extension];
    if (binaryMediaType) return { kind: 'file', mediaType: binaryMediaType, size: file.size };

    const buffer = await readFilePrefix(file.path, MAX_TEXT_PREVIEW_BYTES + 1);
    if (looksBinaryBuffer(buffer.subarray(0, BINARY_SAMPLE_BYTES))) {
      return { kind: 'file', size: file.size };
    }

    const truncated = file.size > MAX_TEXT_PREVIEW_BYTES || buffer.length > MAX_TEXT_PREVIEW_BYTES;
    return {
      kind: 'text',
      content: decodePreviewText(buffer.subarray(0, MAX_TEXT_PREVIEW_BYTES)),
      truncated,
      size: file.size,
    };
  }

  selectFiles(windowId: number, type: 'file' | 'folder' | 'any' = 'file'): Promise<string[]> {
    return this.dependencies.presentation.chooseFiles(windowId, { type });
  }

  async pickBackground(windowId: number): Promise<string | null> {
    const selected = await this.dependencies.presentation.chooseBackgroundImage(windowId);
    if (!selected) return null;
    return this.dependencies.theme.importBackgroundImage(selected);
  }

  clearBackground(): void {
    this.dependencies.theme.clearBackgroundImages();
  }

  setColorScheme(colorScheme: DesktopColorScheme): void {
    this.dependencies.appearance.setColorScheme(colorScheme);
  }

  networkStatus(): boolean {
    return net.isOnline();
  }

  observeNetwork(listener: (online: boolean) => void): () => void {
    let current = this.networkStatus();
    const timer = setInterval(() => {
      const next = this.networkStatus();
      if (next === current) return;
      current = next;
      listener(next);
    }, 2_000);
    return () => clearInterval(timer);
  }

  private requireExistingPath(targetPath: string): string {
    if (!path.isAbsolute(targetPath)) {
      throw new PublicOperationError('invalid-input', 'An absolute path is required');
    }
    try {
      const resolved = fs.realpathSync.native(targetPath);
      const stats = fs.statSync(resolved);
      if (!stats.isFile() && !stats.isDirectory()) {
        throw new Error('Unsupported filesystem object');
      }
      return resolved;
    } catch {
      throw new PublicOperationError('not-found', 'The requested path does not exist');
    }
  }

}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function looksBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length >= 2 && (
    (buffer[0] === 0xff && buffer[1] === 0xfe)
    || (buffer[0] === 0xfe && buffer[1] === 0xff)
  )) return false;

  let controls = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) controls++;
  }
  return buffer.length > 0 && controls / buffer.length > 0.1;
}

function decodePreviewText(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3));
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  return new TextDecoder('utf-8').decode(buffer);
}

async function resolveRegularFile(targetPath: string): Promise<{ path: string; size: number }> {
  if (!path.isAbsolute(targetPath)) {
    throw new PublicOperationError('invalid-input', 'An absolute path is required');
  }
  let resolved: string;
  let stats: fs.Stats;
  try {
    resolved = await fs.promises.realpath(targetPath);
    stats = await fs.promises.stat(resolved);
  } catch {
    throw new PublicOperationError('not-found', 'The requested path does not exist');
  }
  if (!stats.isFile()) {
    throw new PublicOperationError('invalid-input', 'A regular file is required');
  }
  return { path: resolved, size: stats.size };
}

function readClipboardPathCandidates(): string[] {
  const candidates = new Set<string>();
  const addPath = (candidate: string): void => {
    const clean = decodeXml(candidate).replaceAll('\0', '').trim();
    if (path.isAbsolute(clean)) candidates.add(clean);
  };
  const parse = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith('#') || value === 'copy' || value === 'cut') continue;
      if (value.startsWith('file:')) {
        try {
          addPath(fileURLToPath(value));
        } catch {
          // Malformed URLs are ignored alongside stale clipboard entries.
        }
      }
    }
    for (const match of raw.matchAll(/<string>([\s\S]*?)<\/string>/g)) addPath(match[1] ?? '');
  };

  const formats: ReadonlyArray<readonly [string, BufferEncoding]> = [
    ['text/uri-list', 'utf8'],
    ['public.file-url', 'utf8'],
    ['NSFilenamesPboardType', 'utf8'],
    ['FileNameW', 'utf16le'],
  ];
  for (const [format, encoding] of formats) {
    try {
      const buffer = clipboard.readBuffer(format);
      if (buffer.byteLength <= MAX_CLIPBOARD_FORMAT_BYTES) parse(buffer.toString(encoding));
    } catch {
      // Clipboard formats vary by platform.
    }
  }
  if (candidates.size === 0) {
    const text = clipboard.readText().slice(0, MAX_CLIPBOARD_FORMAT_BYTES).trim();
    if (text.startsWith('file:')) parse(text);
    else if (!text.includes('\n')) addPath(text);
  }
  return [...candidates];
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}
