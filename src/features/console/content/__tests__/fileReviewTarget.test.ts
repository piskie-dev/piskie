import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { reviewTargetForPath } from '../fileReviewTarget';
import { deferred } from '../../attachments/__tests__/fixtures';
import type { FilePreviewDescriptor } from '@shared/electron-contracts/desktop';

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
  it.each(['text', 'image'] as const)('discards an obsolete %s request and releases any unused image', async (kind) => {
    const pending = deferred<FilePreviewDescriptor>();
    const onPreviewImage = vi.fn();
    let current = true;
    preview.mockReturnValueOnce(pending.promise);
    const result = reviewTargetForPath('/workspace/sample.dat', onPreviewImage, () => current);
    current = false;
    pending.resolve(kind === 'image'
      ? { kind, revision: 'sample-revision', url: 'piskie-attachment://preview/sample', mediaType: 'image/png', size: 4 }
      : { kind, revision: 'sample-revision', content: 'Sample', truncated: false, size: 6 });
    await expect(result).resolves.toBeNull();
    expect(onPreviewImage).not.toHaveBeenCalled();
    expect(releasePreview).toHaveBeenCalledTimes(kind === 'image' ? 1 : 0);
  });

  it('turns text and unsupported files into path review targets', async () => {
    preview.mockResolvedValueOnce({ kind: 'text', revision: 'sample-revision', content: '# Plan', truncated: false, size: 6 });
    await expect(reviewTargetForPath('/workspace/PLAN.md')).resolves.toEqual({
      kind: 'path',
      path: '/workspace/PLAN.md',
      preview: { kind: 'text', revision: 'sample-revision', content: '# Plan', truncated: false, size: 6 },
    });

    preview.mockResolvedValueOnce({ kind: 'file', revision: 'sample-revision', mediaType: 'application/pdf', size: 20 });
    await expect(reviewTargetForPath('/workspace/report.pdf')).resolves.toEqual({
      kind: 'path',
      path: '/workspace/report.pdf',
      preview: { kind: 'file', revision: 'sample-revision', mediaType: 'application/pdf', size: 20 },
    });
  });

  it.each(['/workspace/sample folder', '/workspace/.示例目录.png', '~/sample folder/.示例目录'])(
    'keeps the complete directory path %s as a review target', async (path) => {
      const onPreviewImage = vi.fn();
      preview.mockResolvedValue({ kind: 'directory', revision: 'sample-revision' });

      await expect(reviewTargetForPath(path, onPreviewImage)).resolves.toEqual({
        kind: 'path', path, preview: { kind: 'directory', revision: 'sample-revision' },
      });
      expect(preview).toHaveBeenCalledExactlyOnceWith(path);
      expect(onPreviewImage).not.toHaveBeenCalled();
      expect(releasePreview).not.toHaveBeenCalled();
    },
  );

  it('discards a rejected request after its selection is superseded', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    let current = true;
    preview.mockReturnValueOnce(pending.promise);
    const result = reviewTargetForPath('/workspace/sample.dat', undefined, () => current);
    current = false;
    pending.reject(new Error('Sample obsolete failure'));
    await expect(result).resolves.toBeNull();
  });

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
      revision: 'sample-revision',
      url: 'piskie-attachment://preview/image',
      mediaType,
      size: 10,
    });

    await expect(reviewTargetForPath(path, onPreviewImage)).resolves.toBeNull();
    expect(onPreviewImage).toHaveBeenCalledWith('piskie-attachment://preview/image', undefined, undefined, expect.any(Function), undefined, [path]);
    expect(releasePreview).not.toHaveBeenCalled();
    onPreviewImage.mock.calls[0]![3]();
    expect(releasePreview).toHaveBeenCalledWith('piskie-attachment://preview/image');
  });
});
