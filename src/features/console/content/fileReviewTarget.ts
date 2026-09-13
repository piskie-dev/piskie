import type { FilePreviewDescriptor } from '../../../../shared/electron-contracts/desktop';

export type ReviewableFilePreview = Exclude<FilePreviewDescriptor, { readonly kind: 'image' }>;

export type FileReviewTarget =
  | { readonly kind: 'cell'; readonly cellId: string }
  | {
      readonly kind: 'path';
      readonly path: string;
      readonly preview: ReviewableFilePreview;
    };

/** Resolve one local path once; images use the lightbox and everything else enters ReviewPanel. */
export async function reviewTargetForPath(
  targetPath: string,
  onPreviewImage?: (src: string, contextUrls?: readonly string[], index?: number, release?: () => void) => void,
): Promise<FileReviewTarget | null> {
  const preview = await window.piskie.desktop.files.preview(targetPath);
  if (preview.kind === 'image') {
    const release = () => { void window.piskie.desktop.files.releasePreview(preview.url).catch(() => undefined); };
    if (onPreviewImage) {
      try { onPreviewImage(preview.url, undefined, undefined, release); } catch (error) { release(); throw error; }
    } else release();
    return null;
  }
  return { kind: 'path', path: targetPath, preview };
}
