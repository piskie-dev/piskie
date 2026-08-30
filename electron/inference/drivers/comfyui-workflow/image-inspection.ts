export interface InspectedImage {
  mimeType: string;
  width?: number;
  height?: number;
}

export function inspectImage(bytes: Uint8Array, declaredMimeType?: string): InspectedImage {
  const png = inspectPng(bytes);
  if (png) return png;
  const jpeg = inspectJpeg(bytes);
  if (jpeg) return jpeg;
  const webp = inspectWebp(bytes);
  if (webp) return webp;
  return { mimeType: normalizeMimeType(declaredMimeType) ?? 'application/octet-stream' };
}

function inspectPng(bytes: Uint8Array): InspectedImage | undefined {
  if (bytes.byteLength < 24
    || bytes[0] !== 0x89
    || bytes[1] !== 0x50
    || bytes[2] !== 0x4e
    || bytes[3] !== 0x47
    || bytes[12] !== 0x49
    || bytes[13] !== 0x48
    || bytes[14] !== 0x44
    || bytes[15] !== 0x52) return undefined;
  return {
    mimeType: 'image/png',
    width: readUint32BigEndian(bytes, 16),
    height: readUint32BigEndian(bytes, 20),
  };
}

function inspectJpeg(bytes: Uint8Array): InspectedImage | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.byteLength) break;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) break;
    if (isJpegStartOfFrame(marker) && segmentLength >= 7) {
      return {
        mimeType: 'image/jpeg',
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += segmentLength;
  }
  return { mimeType: 'image/jpeg' };
}

function inspectWebp(bytes: Uint8Array): InspectedImage | undefined {
  if (bytes.byteLength < 16
    || ascii(bytes, 0, 4) !== 'RIFF'
    || ascii(bytes, 8, 4) !== 'WEBP') return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X' && bytes.byteLength >= 30) {
    return {
      mimeType: 'image/webp',
      width: 1 + readUint24LittleEndian(bytes, 24),
      height: 1 + readUint24LittleEndian(bytes, 27),
    };
  }
  if (chunk === 'VP8 ' && bytes.byteLength >= 30) {
    return {
      mimeType: 'image/webp',
      width: ((bytes[27]! << 8) | bytes[26]!) & 0x3fff,
      height: ((bytes[29]! << 8) | bytes[28]!) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return {
      mimeType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  return { mimeType: 'image/webp' };
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function normalizeMimeType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(';', 1)[0]?.trim().toLowerCase() || undefined;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0)
    + (bytes[offset + 1]! << 16)
    + (bytes[offset + 2]! << 8)
    + bytes[offset + 3]!;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

