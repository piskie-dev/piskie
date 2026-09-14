import type { UserFileRef } from '../../../../shared/types/user-input';
import type { PresentationText } from '../../../i18n/presentationText';

export interface ImageCaptureTask {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

interface ImageIdentity {
  readonly id: string;
  readonly name: string;
}

export type ReadyAttachmentImage = ImageIdentity & { readonly status: 'ready'; readonly blob: Blob };

export type AttachmentImage =
  | ReadyAttachmentImage
  | (ImageIdentity & { readonly status: 'capturing'; readonly capture: ImageCaptureTask })
  | (ImageIdentity & { readonly status: 'error'; readonly error: PresentationText });

export interface AttachmentFile extends UserFileRef {
  readonly id: string;
}

export interface ImagePayload {
  readonly data: string;
  readonly media_type: string;
}

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

const IMAGE_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
});

function extensionOf(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator < 0 ? '' : name.slice(separator + 1).toLowerCase();
}

export function supportedImageType(name: string, declaredType?: string): string | undefined {
  if (declaredType && IMAGE_TYPES.has(declaredType.toLowerCase())) return declaredType.toLowerCase();
  return IMAGE_TYPE_BY_EXTENSION[extensionOf(name)];
}

export function attachmentPathsFromUriList(raw: string): string[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter((value) => {
    if (!value || value.startsWith('#')) return false;
    try {
      const url = new URL(value);
      decodeURIComponent(url.pathname);
      return url.protocol === 'file:';
    } catch {
      return false;
    }
  });
}

export function attachmentPathKey(source: string, platform: string): string {
  if (!source.startsWith('file:')) return platform === 'win32' ? source.replaceAll('/', '\\') : source;
  const url = new URL(source);
  const path = decodeURIComponent(url.pathname);
  if (platform !== 'win32') return url.hostname ? source : path;
  const localPath = url.hostname ? `//${url.hostname}${path}` : path.replace(/^\/(?=[a-z]:)/i, '');
  return localPath.replaceAll('/', '\\');
}

export function plainTextMayReferenceImage(raw: string): boolean {
  const value = raw.trim();
  if (!value || /[\r\n]/.test(value)) return false;
  if (value.startsWith('file:')) {
    try {
      const url = new URL(value);
      const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      return supportedImageType(name) !== undefined;
    } catch {
      return false;
    }
  }
  const absolutePath = value.startsWith('/') || /^[a-z]:[\\/]/i.test(value);
  const name = value.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return absolutePath && supportedImageType(name) !== undefined;
}
