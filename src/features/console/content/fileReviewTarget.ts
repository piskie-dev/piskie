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
  onPreviewImage?: (src: string) => void,
): Promise<FileReviewTarget | null> {
  const preview = await window.piskie.desktop.files.preview(targetPath);
  if (preview.kind === 'image') {
    onPreviewImage?.(preview.url);
    return null;
  }
  return { kind: 'path', path: targetPath, preview };
}
