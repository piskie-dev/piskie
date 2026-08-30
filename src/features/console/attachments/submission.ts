import type { AttachmentFile, ImagePayload } from './model';
import { messageText, PresentationError } from '../../../i18n/presentationText';

export function composeAttachmentText(
  text: string,
  files: readonly Pick<AttachmentFile, 'path'>[],
  hasImages = false,
): string {
  const message = text.trim();
  if (files.length === 0) {
    // i18n-ignore -- model attachment protocol marker
    return message || (hasImages ? '(图片)' : '');
  }
  const references = files.map((file) => `- ${file.path}`).join('\n');
  // i18n-ignore -- model attachment protocol marker
  return `${message ? `${message}\n\n` : ''}附件文件（使用 read 读取）:\n${references}`;
}

export function blobToImagePayload(blob: Blob, mediaType: string): Promise<ImagePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new PresentationError(
      messageText('sessionWorkbenchUi.attachmentFailure.imageRead'),
    ));
    reader.onload = () => {
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
    reader.readAsDataURL(blob);
  });
}
