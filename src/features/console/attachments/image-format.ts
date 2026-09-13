import { messageText, PresentationError } from '../../../i18n/presentationText';

export const IMAGE_LIMITS = Object.freeze({
  imageBytes: 32 * 1024 * 1024,
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
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, count: number) => String.fromCharCode(...bytes.subarray(at, at + count));
  let mediaType: string;
  let width = 0;
  let height = 0;
  if (bytes.length >= 33 && bytes[0] === 137 && text(1, 7) === 'PNG\r\n\x1a\n'
    && view.getUint32(8) === 13 && text(12, 4) === 'IHDR') {
    mediaType = 'image/png';
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 13 && (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a')) {
    mediaType = 'image/gif';
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
    checkDimensions(width, height);
    let at = 13;
    const skip = (count: number) => {
      if (at + count > bytes.length) throw attachmentError('invalidImage');
      at += count;
    };
    const skipColorTable = (packed: number) => { if (packed & 0x80) skip(3 * (1 << ((packed & 7) + 1))); };
    const skipBlocks = () => {
      for (;;) {
        if (at >= bytes.length) throw attachmentError('invalidImage');
        const length = bytes[at++]!;
        if (length === 0) return;
        skip(length);
      }
    };
    skipColorTable(bytes[10]!);
    while (at < bytes.length) {
      const marker = bytes[at++]!;
      if (marker === 0x3b) break;
      if (marker === 0x21) {
        skip(1); // Extension label, followed by length-prefixed blocks.
        skipBlocks();
      } else if (marker === 0x2c) {
        if (at + 9 > bytes.length) throw attachmentError('invalidImage');
        const left = view.getUint16(at, true);
        const top = view.getUint16(at + 2, true);
        const frameWidth = view.getUint16(at + 4, true);
        const frameHeight = view.getUint16(at + 6, true);
        checkDimensions(frameWidth, frameHeight);
        // Decoders may expand beyond the logical screen to accommodate frame bounds.
        width = Math.max(width, left + frameWidth);
        height = Math.max(height, top + frameHeight);
        checkDimensions(width, height);
        const packed = bytes[at + 8]!;
        skip(9);
        skipColorTable(packed);
        skip(1); // LZW minimum code size; compressed data remains the decoder's responsibility.
        skipBlocks();
      } else {
        throw attachmentError('invalidImage');
      }
    }
  } else if (bytes.length >= 26 && text(0, 2) === 'BM') {
    mediaType = 'image/bmp';
    const header = view.getUint32(14, true);
    if (header === 12) {
      width = view.getUint16(18, true);
      height = view.getUint16(20, true);
    } else if (header >= 40 && bytes.length >= 14 + header) {
      width = view.getInt32(18, true);
      height = Math.abs(view.getInt32(22, true));
    }
  } else if (bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    mediaType = 'image/webp';
    if (view.getUint32(4, true) + 8 !== bytes.length) throw attachmentError('invalidImage');
    const uint24 = (at: number) => bytes[at]! + (bytes[at + 1]! << 8) + (bytes[at + 2]! << 16);
    for (let at = 12; at + 8 <= bytes.length;) {
      const kind = text(at, 4);
      const length = view.getUint32(at + 4, true);
      const data = at + 8;
      if (data + length > bytes.length) throw attachmentError('invalidImage');
      if (kind === 'VP8X' && length >= 10) {
        width = uint24(data + 4) + 1;
        height = uint24(data + 7) + 1;
        break;
      }
      if (kind === 'VP8 ' && length >= 10 && text(data + 3, 3) === '\x9d\x01\x2a') {
        width = view.getUint16(data + 6, true) & 0x3fff;
        height = view.getUint16(data + 8, true) & 0x3fff;
        break;
      }
      if (kind === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
        const bits = view.getUint32(data + 1, true);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        break;
      }
      at = data + length + (length % 2);
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mediaType = 'image/jpeg';
    for (let at = 2; at < bytes.length;) {
      if (bytes[at++] !== 0xff) throw attachmentError('invalidImage');
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9 || marker === undefined) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8) break;
        height = view.getUint16(at + 3);
        width = view.getUint16(at + 5);
        break;
      }
      at += length;
    }
  } else {
    throw attachmentError('invalidImage');
  }
  checkDimensions(width, height);
  return { mediaType, width, height };
}

function checkDimensions(width: number, height: number): void {
  if (width <= 0 || height <= 0) throw attachmentError('invalidImage');
  if (width * height > IMAGE_LIMITS.pixels) throw attachmentError('pixels');
}
