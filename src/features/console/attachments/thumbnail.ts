import { attachmentError, IMAGE_LIMITS } from './image-format';

/** createImageBitmap snapshots the first frame of animated image sources. */
export async function createImageThumbnail(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, IMAGE_LIMITS.thumbnailEdge / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw attachmentError('thumbnail');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(attachmentError('thumbnail')), 'image/png');
    });
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
