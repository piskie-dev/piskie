import { describe, expect, it } from 'vitest';
import {
  isTextAttachment,
  plainTextMayReferenceImage,
  supportedImageType,
  uriListMayContainAttachment,
} from '../model';
import { composeAttachmentText } from '../submission';

describe('attachment policy', () => {
  it('accepts supported raster images without treating SVG as an AI image', () => {
    expect(supportedImageType('capture', 'image/png')).toBe('image/png');
    expect(supportedImageType('photo.JPEG')).toBe('image/jpeg');
    expect(supportedImageType('drawing.svg', 'image/svg+xml')).toBeUndefined();
  });

  it('recognizes text and code files but not PDF or Word documents', () => {
    expect(isTextAttachment('notes.md')).toBe(true);
    expect(isTextAttachment('source', 'application/typescript')).toBe(true);
    expect(isTextAttachment('manual.pdf', 'application/pdf')).toBe(false);
    expect(isTextAttachment('draft.docx')).toBe(false);
  });

  it('only intercepts URI lists that contain supported attachments', () => {
    expect(uriListMayContainAttachment('file:///tmp/screen%20shot.png')).toBe(true);
    expect(uriListMayContainAttachment('# copied files\nfile:///tmp/notes.txt')).toBe(true);
    expect(uriListMayContainAttachment('file:///tmp/manual.pdf')).toBe(false);
    expect(uriListMayContainAttachment('ordinary pasted text')).toBe(false);
  });

  it('keeps the Linux plain-text image-path fallback without intercepting ordinary text', () => {
    expect(plainTextMayReferenceImage('file:///tmp/screenshot.webp')).toBe(true);
    expect(plainTextMayReferenceImage('/tmp/screenshot.jpg')).toBe(true);
    expect(plainTextMayReferenceImage('C:\\Temp\\screenshot.png')).toBe(true);
    expect(plainTextMayReferenceImage('/tmp/notes.txt')).toBe(false);
    expect(plainTextMayReferenceImage('write /tmp/screenshot.png')).toBe(false);
  });
});

describe('attachment submission text', () => {
  it('keeps file references in the existing read-tool format', () => {
    expect(composeAttachmentText('检查这些文件', [
      { path: '/tmp/a.txt' },
      { path: '/tmp/b.md' },
    ])).toBe('检查这些文件\n\n附件文件（使用 read 读取）:\n- /tmp/a.txt\n- /tmp/b.md');
  });

  it('uses an image placeholder only when the message contains an image', () => {
    expect(composeAttachmentText('', [], true)).toBe('(图片)');
    expect(composeAttachmentText('', [], false)).toBe('');
  });
});
