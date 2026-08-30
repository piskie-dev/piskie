import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { reviewTargetForPath } from '../fileReviewTarget';

const preview = vi.fn();

vi.stubGlobal('window', {
  piskie: {
    desktop: {
      files: { preview },
    },
  },
});

afterEach(() => {
  preview.mockReset();
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

  it('sends images to the lightbox instead of opening ReviewPanel', async () => {
    const onPreviewImage = vi.fn();
    preview.mockResolvedValue({
      kind: 'image',
      url: 'piskie-attachment://preview/image',
      mediaType: 'image/png',
      size: 10,
    });

    await expect(reviewTargetForPath('/workspace/image.png', onPreviewImage)).resolves.toBeNull();
    expect(onPreviewImage).toHaveBeenCalledWith('piskie-attachment://preview/image');
  });
});
