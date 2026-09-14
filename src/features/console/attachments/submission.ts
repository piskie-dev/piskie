import type { ImagePayload } from './model';
import { messageText, PresentationError } from '../../../i18n/presentationText';

export function blobToImagePayload(blob: Blob, mediaType: string, signal?: AbortSignal): Promise<ImagePayload> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const reader = new FileReader();
    const abort = () => reader.abort();
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      reader.onload = reader.onerror = reader.onabort = null;
    };
    reader.onabort = () => { finish(); reject(signal?.reason); };
    reader.onerror = () => { finish(); reject(new PresentationError(
      messageText('sessionWorkbenchUi.attachmentFailure.imageRead'),
    )); };
    reader.onload = () => {
      finish();
      if (typeof reader.result !== 'string') {
        reject(new PresentationError(
          messageText('sessionWorkbenchUi.attachmentFailure.imageRead'),
        ));
        return;
      }
      const separator = reader.result.indexOf(',');
      if (separator < 0 || separator === reader.result.length - 1) {
        reject(new PresentationError(
          messageText('sessionWorkbenchUi.attachmentFailure.imageEncoding'),
        ));
        return;
      }
      resolve({ data: reader.result.slice(separator + 1), media_type: mediaType });
    };
    signal?.addEventListener('abort', abort, { once: true });
    try { reader.readAsDataURL(blob); } catch (error) { finish(); reject(error); }
  });
}
