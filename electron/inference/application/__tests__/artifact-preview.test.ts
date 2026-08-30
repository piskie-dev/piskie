import { describe, expect, it, vi } from 'vitest';
import type { ArtifactReader } from '../../execution/artifact-port.js';
import {
  ArtifactPreviewError,
  MAX_ARTIFACT_PREVIEW_BYTES,
  readArtifactPreview,
} from '../artifact-preview.js';

const artifactId = `artifact:sha256:${'a'.repeat(64)}`;

describe('readArtifactPreview', () => {
  it('reads only the addressed artifact and returns an image data URL', async () => {
    const read = vi.fn<ArtifactReader['read']>().mockResolvedValue({
      bytes: new Uint8Array(Buffer.from('preview-pixels')),
      mimeType: 'image/webp',
    });

    await expect(readArtifactPreview({ read }, artifactId)).resolves.toEqual({
      artifactId,
      mimeType: 'image/webp',
      dataUrl: `data:image/webp;base64,${Buffer.from('preview-pixels').toString('base64')}`,
    });
    expect(read).toHaveBeenCalledWith({ artifactId }, undefined);
  });

  it('rejects non-content-addressed IDs before touching the artifact store', async () => {
    const read = vi.fn<ArtifactReader['read']>();

    await expect(readArtifactPreview({ read }, '../../secret')).rejects.toMatchObject<ArtifactPreviewError>({
      code: 'ARTIFACT_ID_INVALID',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects non-image and oversized payloads at the renderer boundary', async () => {
    await expect(readArtifactPreview({
      read: async () => ({ bytes: new Uint8Array([1]), mimeType: 'text/plain' }),
    }, artifactId)).rejects.toMatchObject<ArtifactPreviewError>({ code: 'ARTIFACT_NOT_IMAGE' });

    await expect(readArtifactPreview({
      read: async () => ({
        bytes: new Uint8Array(MAX_ARTIFACT_PREVIEW_BYTES + 1),
        mimeType: 'image/png',
      }),
    }, artifactId)).rejects.toMatchObject<ArtifactPreviewError>({ code: 'ARTIFACT_PREVIEW_TOO_LARGE' });
  });
});
