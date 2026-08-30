export interface AttachmentImage {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly previewUrl: string;
}

export interface AttachmentFile {
  readonly id: string;
  readonly name: string;
  readonly path: string;
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

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'xml', 'csv', 'log', 'yaml', 'yml', 'toml',
  'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp',
  'h', 'hpp', 'css', 'scss', 'less', 'html', 'htm', 'sh', 'bash',
  'zsh', 'sql', 'graphql', 'env', 'conf', 'ini', 'cfg',
]);

const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
]);

function extensionOf(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator < 0 ? '' : name.slice(separator + 1).toLowerCase();
}

export function supportedImageType(name: string, declaredType?: string): string | undefined {
  if (declaredType && IMAGE_TYPES.has(declaredType.toLowerCase())) return declaredType.toLowerCase();
  return IMAGE_TYPE_BY_EXTENSION[extensionOf(name)];
}

export function isTextAttachment(name: string, declaredType?: string): boolean {
  const normalizedType = declaredType?.toLowerCase() ?? '';
  return normalizedType.startsWith('text/')
    || TEXT_APPLICATION_TYPES.has(normalizedType)
    || TEXT_EXTENSIONS.has(extensionOf(name));
}

export function uriListMayContainAttachment(raw: string): boolean {
  return raw.split(/\r?\n/).some((line) => {
    const value = line.trim();
    if (!value || value.startsWith('#')) return false;
    try {
      const url = new URL(value);
      const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      return url.protocol === 'file:'
        && (supportedImageType(name) !== undefined || isTextAttachment(name));
    } catch {
      return false;
    }
  });
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
