import { ImageFormatError, inspectRasterImage, MAX_IMAGE_BYTES } from '@shared/utils/image-format';
import { messageText, PresentationError } from '../../../i18n/presentationText';

export const IMAGE_LIMITS = Object.freeze({
  imageBytes: MAX_IMAGE_BYTES,
  draftBytes: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  captureBytes: 64 * 1024 * 1024,
  pixels: 32_000_000,
  count: 32,
  thumbnailBytes: 16 * 1024 * 1024,
  thumbnailEdge: 256,
});

export function attachmentError(code: string, values?: Readonly<Record<string, number>>): PresentationError {
  return new PresentationError(messageText(`sessionWorkbenchUi.attachmentFailure.${code}`, values));
}

/** Reads encoded dimensions before any browser decoder is invoked. */
export function inspectImage(bytes: Uint8Array): { mediaType: string; width: number; height: number } {
  try {
    return inspectRasterImage(bytes, IMAGE_LIMITS.pixels);
  } catch (error) {
    if (error instanceof ImageFormatError) throw attachmentError(error.code);
    throw error;
  }
}
