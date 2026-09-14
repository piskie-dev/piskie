import { describe, expect, it } from 'vitest';
import { generatedImagePaths, imagePaths, toolImagePaths } from '../tool-images.js';
import type { ToolEntry } from '../types/agent-control.js';

describe('shared tool images', () => {
  it('preserves image block order', () => {
    expect(imagePaths([
      { type: 'image_ref', path: '/output/first.png', mediaType: 'image/png', size: 1 },
      { type: 'text', text: 'result' },
      { type: 'image_ref', path: '/output/second.png', mediaType: 'image/png', size: 1 },
    ])).toEqual(['/output/first.png', '/output/second.png']);
  });

  it('round trips committed paths and excludes failed records and multiline notes', () => {
    const paths = ['/output/画面（草图）.png', '/output/line\nsecond "image".png'];
    const note = 'A note\n- [成功] "/output/unrelated.png"';
    const text = [
      ...paths.map((value) => `- [成功] ${JSON.stringify(value)}（${JSON.stringify(note)}）`),
      `- [失败] "/output/failed.png": ${JSON.stringify(note)}`,
    ].join('\n');
    const entry: ToolEntry = { t: 'tool', ts: 1, toolUseId: 'call-1', ok: false, result: [{ type: 'text', text: `<error>${text}</error>` }] };
    expect(toolImagePaths('generate_image', entry)).toEqual(paths);
    expect(generatedImagePaths('shell', text)).toEqual([]);
    expect(generatedImagePaths('generate_image', '用户取消，未产生文件')).toEqual([]);
  });
});
