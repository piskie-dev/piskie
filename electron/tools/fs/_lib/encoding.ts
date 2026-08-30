export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be';

export function detectTextEncoding(buffer: Buffer): TextEncoding {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf8-bom';
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf16be';
  return 'utf8';
}

export function decodeText(buffer: Buffer, encoding = detectTextEncoding(buffer)): string {
  if (encoding === 'utf8-bom') return buffer.subarray(3).toString('utf8');
  if (encoding === 'utf16le') return buffer.subarray(2).toString('utf16le');
  if (encoding === 'utf16be') {
    const body = Buffer.from(buffer.subarray(2));
    if (body.length % 2 !== 0) return body.subarray(0, body.length - 1).swap16().toString('utf16le');
    return body.swap16().toString('utf16le');
  }
  return buffer.toString('utf8');
}

export function encodeText(text: string, encoding: TextEncoding): Buffer {
  if (encoding === 'utf8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf16be') {
    const body = Buffer.from(text, 'utf16le');
    body.swap16();
    return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
  }
  return Buffer.from(text, 'utf8');
}
