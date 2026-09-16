import type { CopyImageRequest } from '@shared/electron-contracts/desktop';
import { retainFilePreviews } from './file-preview';

export type ImageCopySource =
  | { readonly kind: 'url'; readonly url: string; readonly name?: string }
  | { readonly kind: 'blob'; readonly blob: Blob; readonly name?: string }
  | { readonly kind: 'path'; readonly path: string };

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** Copies the original file bytes; resolves only after the desktop publishes the file. */
export async function copyImage(source: ImageCopySource): Promise<void> {
  const release = retainFilePreviews(source.kind === 'url' ? [source.url] : []);
  try {
    let request: CopyImageRequest;
    if (source.kind === 'path') {
      request = source;
    } else if (source.kind === 'blob') {
      request = { kind: 'bytes', bytes: await source.blob.arrayBuffer(), name: source.name };
    } else {
      const protocol = new URL(source.url).protocol;
      if (protocol === 'blob:' || protocol === 'data:') {
        // Start reading while the clicked view still owns the URL. No image decode or canvas conversion.
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`Image read failed (${response.status})`);
        request = { kind: 'bytes', bytes: await response.arrayBuffer(), name: source.name };
      } else if (protocol === 'piskie-attachment:') {
        request = { kind: 'preview', url: source.url };
      } else {
        request = { kind: 'url', url: source.url, name: source.name };
      }
    }
    await window.piskie.desktop.files.copyImage(request);
  } finally {
    release();
  }
}
