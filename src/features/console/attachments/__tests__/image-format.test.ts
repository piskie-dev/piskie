import { describe, expect, it } from 'vitest';
import { inspectImage } from '../image-format';
import { gifBytes, pngBytes } from './fixtures';

describe('encoded image metadata', () => {
  it('reads PNG dimensions and rejects excessive pixels before decoding', () => {
    const bytes = pngBytes(8, 4);
    expect(inspectImage(bytes)).toEqual({ mediaType: 'image/png', width: 8, height: 4 });
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 8000); view.setUint32(20, 4000);
    expect(inspectImage(bytes).width).toBe(8000);
    view.setUint32(20, 4001);
    expect(() => inspectImage(bytes)).toThrow('pixels');
  });

  it.each(['GIF87a', 'GIF89a'])('reads %s logical screen dimensions', (signature) => {
    const bytes = gifBytes(12, 9);
    bytes.set(Buffer.from(signature));
    expect(inspectImage(bytes)).toEqual({ mediaType: 'image/gif', width: 12, height: 9 });
  });

  it('includes frame dimensions beyond a small logical screen and accepts ordinary multiple frames', () => {
    expect(inspectImage(gifBytes(1, 1, [{ left: 0, top: 0, width: 20, height: 15 }])))
      .toEqual({ mediaType: 'image/gif', width: 20, height: 15 });
    expect(inspectImage(gifBytes(20, 15, [
      { left: 0, top: 0, width: 20, height: 15 },
      { left: 2, top: 3, width: 4, height: 5 },
    ]))).toEqual({ mediaType: 'image/gif', width: 20, height: 15 });
  });

  it.each(['first-frame', 'later-frame', 'frame-offset'])('checks the pixel limit in the %s header without decoding', (kind) => {
    const bytes = gifBytes(1, 1, [
      { left: 0, top: 0, width: 2, height: 2 },
      { left: 0, top: 0, width: 2, height: 2 },
    ]);
    const first = bytes.indexOf(0x2c);
    const at = kind === 'first-frame' ? first : bytes.indexOf(0x2c, first + 1);
    const view = new DataView(bytes.buffer);
    view.setUint16(at + 5, 8000, true);
    view.setUint16(at + 7, 4000, true);
    expect(inspectImage(bytes)).toMatchObject({ width: 8000, height: 4000 });
    if (kind === 'frame-offset') view.setUint16(at + 1, 1, true);
    else view.setUint16(at + 7, 4001, true);
    expect(() => inspectImage(bytes)).toThrow('pixels');
  });

  it('rejects truncated GIF blocks that prevent locating subsequent frame dimensions', () => {
    const bytes = gifBytes();
    expect(() => inspectImage(bytes.subarray(0, 15))).toThrow('invalidImage');
    expect(() => inspectImage(bytes.subarray(0, bytes.indexOf(0x2c) + 5))).toThrow('invalidImage');
    expect(() => inspectImage(bytes.subarray(0, bytes.length - 3))).toThrow('invalidImage');
  });

  it('walks JPEG segments to its frame marker', () => {
    const bytes = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0, 255, 194, 0, 8, 8, 0, 6, 0, 7, 1]);
    expect(inspectImage(bytes)).toEqual({ mediaType: 'image/jpeg', width: 7, height: 6 });
    bytes[5] = 250;
    expect(() => inspectImage(bytes)).toThrow('invalidImage');
  });

  it.each([12, 40, 108, 124])('reads BMP DIB header %i', (header) => {
    const bytes = new Uint8Array(Math.max(26, 14 + header));
    const view = new DataView(bytes.buffer);
    bytes.set(Buffer.from('BM')); view.setUint32(14, header, true);
    if (header === 12) { view.setUint16(18, 7, true); view.setUint16(20, 6, true); }
    else { view.setInt32(18, 7, true); view.setInt32(22, -6, true); }
    expect(inspectImage(bytes)).toEqual({ mediaType: 'image/bmp', width: 7, height: 6 });
  });

  it.each(['VP8 ', 'VP8L', 'VP8X'])('reads WebP %s dimensions', (format) => {
    const bytes = new Uint8Array(30);
    const view = new DataView(bytes.buffer);
    bytes.set(Buffer.from('RIFF')); view.setUint32(4, 22, true);
    bytes.set(Buffer.from('WEBP' + format), 8); view.setUint32(16, 10, true);
    if (format === 'VP8 ') {
      bytes.set([157, 1, 42], 23); view.setUint16(26, 7, true); view.setUint16(28, 6, true);
    } else if (format === 'VP8L') {
      bytes[20] = 47; view.setUint32(21, 6 | (5 << 14), true);
    } else { bytes[24] = 6; bytes[27] = 5; }
    expect(inspectImage(bytes)).toEqual({ mediaType: 'image/webp', width: 7, height: 6 });
    view.setUint32(16, 30, true);
    expect(() => inspectImage(bytes)).toThrow('invalidImage');
  });

  it.each([new Uint8Array(), new Uint8Array([1, 2, 3]), pngBytes().subarray(0, 20)])('rejects empty or truncated bytes', (bytes) => {
    expect(() => inspectImage(bytes)).toThrow('invalidImage');
  });
});
