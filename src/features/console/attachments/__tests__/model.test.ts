import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  plainTextMayReferenceImage,
  supportedImageType,
  attachmentPathsFromUriList,
  attachmentPathKey,
} from '../model';

describe('attachment policy', () => {
  it('accepts supported raster images without treating SVG as an AI image', () => {
    expect(supportedImageType('capture', 'image/png')).toBe('image/png');
    expect(supportedImageType('photo.JPEG')).toBe('image/jpeg');
    expect(supportedImageType('drawing.svg', 'image/svg+xml')).toBeUndefined();
  });

  it('accepts local file URIs of any format and leaves other content alone', () => {
    expect(attachmentPathsFromUriList('file:///tmp/screen%20shot.png')).toEqual(['file:///tmp/screen%20shot.png']);
    expect(attachmentPathsFromUriList('# copied files\nfile:///tmp/notes.txt')).toEqual(['file:///tmp/notes.txt']);
    expect(attachmentPathsFromUriList('file:///sample/manual.pdf\nfile:///sample/draft.docx\nfile:///sample/archive.zip'))
      .toEqual(['file:///sample/manual.pdf', 'file:///sample/draft.docx', 'file:///sample/archive.zip']);
    expect(attachmentPathsFromUriList('https://example.test/sample.pdf\nfile:///sample/bad%name.pdf')).toEqual([]);
    expect(attachmentPathsFromUriList('ordinary pasted text')).toEqual([]);
  });

  it.each([
    ['linux', 'file:///sample%20files/example.pdf', '/sample files/example.pdf'],
    ['darwin', 'file:///sample%20files/example.pdf', '/sample files/example.pdf'],
    ['win32', 'file:///C:/Sample%20Files/example.pdf', 'C:\\Sample Files\\example.pdf'],
    ['win32', 'file://example-server/share/example.pdf', '\\\\example-server\\share\\example.pdf'],
    ['linux', 'file:///sample%20files/%E8%B5%84%E6%96%99%20%231%2525.pdf', '/sample files/资料 #1%25.pdf'],
    ['darwin', 'file:///sample%20files/%E8%B5%84%E6%96%99%20%231%2525.pdf', '/sample files/资料 #1%25.pdf'],
    ['win32', 'file:///C:/Sample%20Files/%E8%B5%84%E6%96%99%20%231%2525.pdf', 'C:\\Sample Files\\资料 #1%25.pdf'],
    ['win32', 'file://example-server/share/%E8%B5%84%E6%96%99%20%231%2525.pdf', '\\\\example-server\\share\\资料 #1%25.pdf'],
  ])('deduplicates a %s file URI and its native File path', (platform, uri, path) => {
    expect(attachmentPathsFromUriList(uri!)).toEqual([uri]);
    expect(fileURLToPath(uri!, { windows: platform === 'win32' })).toBe(path);
    expect(attachmentPathKey(uri!, platform!)).toBe(attachmentPathKey(path!, platform!));
  });

  it('keeps the Linux plain-text image-path fallback without intercepting ordinary text', () => {
    expect(plainTextMayReferenceImage('file:///tmp/screenshot.webp')).toBe(true);
    expect(plainTextMayReferenceImage('/tmp/screenshot.jpg')).toBe(true);
    expect(plainTextMayReferenceImage('C:\\Temp\\screenshot.png')).toBe(true);
    expect(plainTextMayReferenceImage('/tmp/notes.txt')).toBe(false);
    expect(plainTextMayReferenceImage('write /tmp/screenshot.png')).toBe(false);
  });
});
