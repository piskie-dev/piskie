import { deflateSync } from 'node:zlib';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Synthetic solid pixels, with real PNG chunks and CRCs. */
export function pngBytes(width = 2, height = 2): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Buffer) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([header, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height, 128);
  for (let row = 0; row < height; row++) raw[row * (width * 4 + 1)] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Small GIF frames with a global palette, local palettes and ordinary extension blocks. */
export function gifBytes(width = 2, height = 2, frames = [{ left: 0, top: 0, width, height }]): Uint8Array<ArrayBuffer> {
  const word = (value: number) => [value & 255, value >> 8];
  const palette = [255, 0, 0, 0, 0, 255];
  const bytes = [...Buffer.from('GIF89a'), ...word(width), ...word(height), 0x80, 0, 0, ...palette,
    0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0,
    0x21, 0xfe, 7, ...Buffer.from('Example'), 0];
  for (const [index, frame] of frames.entries()) {
    bytes.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c,
      ...word(frame.left), ...word(frame.top), ...word(frame.width), ...word(frame.height), 0x80, ...palette, 2);
    // Clear before each pixel so every LZW code remains three bits, suitable for tiny fixtures.
    const codes: number[] = [];
    for (let pixel = 0; pixel < frame.width * frame.height; pixel++) codes.push(4, index % 2);
    codes.push(5);
    let bits = 0, count = 0;
    const compressed: number[] = [];
    for (const code of codes) {
      bits |= code << count; count += 3;
      if (count >= 8) { compressed.push(bits & 255); bits >>= 8; count -= 8; }
    }
    if (count > 0) compressed.push(bits);
    for (let at = 0; at < compressed.length; at += 255) {
      const block = compressed.slice(at, at + 255);
      bytes.push(block.length, ...block);
    }
    bytes.push(0);
  }
  return new Uint8Array([...bytes, 0x3b]);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
