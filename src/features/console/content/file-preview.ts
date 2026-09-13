import type { FilePreviewDescriptor } from '../../../../shared/electron-contracts/desktop';

const users = new Map<string, number>();

export async function acquireFilePreview(path: string): Promise<FilePreviewDescriptor> {
  const preview = await window.piskie.desktop.files.preview(path);
  if (preview.kind === 'image') users.set(preview.url, 1);
  return preview;
}

export function clearFilePreviews(): void {
  for (const url of users.keys()) {
    void window.piskie.desktop.files.releasePreview(url).catch(() => undefined);
  }
  users.clear();
}

export function releaseFilePreview(url: string): void {
  const count = users.get(url);
  if (count === undefined) return;
  if (count > 1) users.set(url, count - 1);
  else {
    users.delete(url);
    void window.piskie.desktop.files.releasePreview(url).catch(() => undefined);
  }
}

/** A lightbox may outlive the thumbnail that opened it. Acquire before returning to that caller. */
export function retainFilePreviews(urls: readonly string[]): () => void {
  const retained = [...new Set(urls)].filter((url) => users.has(url));
  for (const url of retained) users.set(url, users.get(url)! + 1);
  return () => { for (const url of retained.splice(0)) releaseFilePreview(url); };
}
