import type { FilePreviewDescriptor } from '../../../../shared/electron-contracts/desktop';
import type { ImagePreviewHandler } from '@/components/image-preview/renderedImageContext';

export type ReviewableFilePreview = Exclude<FilePreviewDescriptor, { readonly kind: 'image' }>;

export type FileReviewTarget =
  | { readonly kind: 'collection' }
  | { readonly kind: 'cell'; readonly cellId: string }
  | {
      readonly kind: 'path';
      readonly path: string;
      readonly preview: ReviewableFilePreview;
    };

export type PathReviewTarget = Extract<FileReviewTarget, { readonly kind: 'path' }>;
export type UpdateFileReviewTarget = (expected: PathReviewTarget, next: PathReviewTarget | null) => void;

export function releaseUnusedPreview(preview: FilePreviewDescriptor): void {
  if (preview.kind === 'image') {
    void window.piskie.desktop.files.releasePreview(preview.url).catch(() => undefined);
  }
}

/** Transfer image ownership to the lightbox; non-images stay with the review target owner. */
export function reviewTargetFromPreview(
  targetPath: string,
  preview: FilePreviewDescriptor,
  onPreviewImage?: ImagePreviewHandler,
): PathReviewTarget | null {
  if (preview.kind === 'image') {
    const release = () => releaseUnusedPreview(preview);
    if (onPreviewImage) {
      try { onPreviewImage(preview.url, undefined, undefined, release, undefined, [targetPath]); } catch (error) { release(); throw error; }
    } else release();
    return null;
  }
  return { kind: 'path', path: targetPath, preview };
}

/** Resolve one local path once; images use the lightbox and everything else enters ReviewPanel. */
export async function reviewTargetForPath(
  targetPath: string,
  onPreviewImage?: ImagePreviewHandler,
  isCurrent: () => boolean = () => true,
): Promise<FileReviewTarget | null> {
  let preview: FilePreviewDescriptor;
  try { preview = await window.piskie.desktop.files.preview(targetPath); }
  catch (error) { if (!isCurrent()) return null; throw error; }
  if (!isCurrent()) {
    releaseUnusedPreview(preview);
    return null;
  }
  return reviewTargetFromPreview(targetPath, preview, onPreviewImage);
}
