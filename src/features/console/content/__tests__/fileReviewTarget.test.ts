import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { reviewTargetForPath } from '../fileReviewTarget';

const preview = vi.fn();
const releasePreview = vi.fn().mockResolvedValue(undefined);

vi.stubGlobal('window', {
  piskie: {
    desktop: {
      files: { preview, releasePreview },
    },
  },
});

afterEach(() => {
  preview.mockReset();
  releasePreview.mockClear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('reviewTargetForPath', () => {
  it('turns text and unsupported files into path review targets', async () => {
    preview.mockResolvedValueOnce({ kind: 'text', content: '# Plan', truncated: false, size: 6 });
    await expect(reviewTargetForPath('/workspace/PLAN.md')).resolves.toEqual({
      kind: 'path',
      path: '/workspace/PLAN.md',
      preview: { kind: 'text', content: '# Plan', truncated: false, size: 6 },
    });

    preview.mockResolvedValueOnce({ kind: 'file', mediaType: 'application/pdf', size: 20 });
    await expect(reviewTargetForPath('/workspace/report.pdf')).resolves.toEqual({
      kind: 'path',
      path: '/workspace/report.pdf',
      preview: { kind: 'file', mediaType: 'application/pdf', size: 20 },
    });
  });

  it.each(['/workspace/sample folder', '/workspace/.示例目录.png', '~/sample folder/.示例目录'])(
    'keeps the complete directory path %s as a review target', async (path) => {
      const onPreviewImage = vi.fn();
      preview.mockResolvedValue({ kind: 'directory' });

      await expect(reviewTargetForPath(path, onPreviewImage)).resolves.toEqual({
        kind: 'path', path, preview: { kind: 'directory' },
      });
      expect(preview).toHaveBeenCalledExactlyOnceWith(path);
      expect(onPreviewImage).not.toHaveBeenCalled();
      expect(releasePreview).not.toHaveBeenCalled();
    },
  );

  it('preserves a missing-path error without creating a review target', async () => {
    const error = new Error('The requested path does not exist');
    preview.mockRejectedValue(error);
    await expect(reviewTargetForPath('/workspace/missing folder')).rejects.toBe(error);
  });

  it.each([
    ['/workspace/vector.svg', 'image/svg+xml'],
    ['/workspace/photo.avif', 'image/avif'],
    ['/workspace/favicon.ico', 'image/vnd.microsoft.icon'],
  ])('sends %s to the lightbox instead of opening ReviewPanel', async (path, mediaType) => {
    const onPreviewImage = vi.fn();
    preview.mockResolvedValue({
      kind: 'image',
      url: 'piskie-attachment://preview/image',
      mediaType,
      size: 10,
    });

    await expect(reviewTargetForPath(path, onPreviewImage)).resolves.toBeNull();
    expect(onPreviewImage).toHaveBeenCalledWith('piskie-attachment://preview/image', undefined, undefined, expect.any(Function));
    expect(releasePreview).not.toHaveBeenCalled();
    onPreviewImage.mock.calls[0]![3]();
    expect(releasePreview).toHaveBeenCalledWith('piskie-attachment://preview/image');
  });
});
