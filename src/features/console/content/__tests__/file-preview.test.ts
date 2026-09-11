import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireFilePreview, releaseFilePreview, retainFilePreviews } from '../file-preview';

afterEach(() => vi.unstubAllGlobals());
describe('ordinary preview leases', () => {
  it('keeps a lightbox source readable after its opening thumbnail is unmounted', async () => {
    const releasePreview = vi.fn().mockResolvedValue(undefined);
    const url = 'piskie-attachment://preview/example';
    vi.stubGlobal('window', { piskie: { desktop: { files: {
      preview: vi.fn().mockResolvedValue({ kind: 'image', url, mediaType: 'image/png', size: 20 }), releasePreview,
    } } } });
    await acquireFilePreview('/workspace/example.png');
    const close = retainFilePreviews([url, url]);
    releaseFilePreview(url);
    expect(releasePreview).not.toHaveBeenCalled();
    close(); close();
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('does not take ownership of unmanaged URLs used by other preview sources', () => {
    const close = retainFilePreviews(['blob:example']);
    expect(() => close()).not.toThrow();
  });
});
