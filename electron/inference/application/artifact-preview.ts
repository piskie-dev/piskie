import type { InferenceArtifactPreview } from '../../../shared/types/inference.js';
import type { ArtifactReader } from '../execution/artifact-port.js';

export const MAX_ARTIFACT_PREVIEW_BYTES = 32 * 1024 * 1024;

export class ArtifactPreviewError extends Error {
  constructor(
    readonly code: 'ARTIFACT_ID_INVALID' | 'ARTIFACT_NOT_IMAGE' | 'ARTIFACT_PREVIEW_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactPreviewError';
  }
}

export async function readArtifactPreview(
  artifacts: ArtifactReader,
  artifactId: string,
  signal?: AbortSignal,
): Promise<InferenceArtifactPreview> {
  if (!/^artifact:sha256:[a-f0-9]{64}$/.test(artifactId)) {
    throw new ArtifactPreviewError('ARTIFACT_ID_INVALID', 'Invalid image artifact ID');
  }

  const payload = await artifacts.read({ artifactId }, signal);
  if (!payload.mimeType.startsWith('image/')) {
    throw new ArtifactPreviewError(
      'ARTIFACT_NOT_IMAGE',
      `Artifact ${artifactId} is not an image`,
    );
  }
  if (payload.bytes.byteLength > MAX_ARTIFACT_PREVIEW_BYTES) {
    throw new ArtifactPreviewError(
      'ARTIFACT_PREVIEW_TOO_LARGE',
      `Artifact ${artifactId} exceeds the ${MAX_ARTIFACT_PREVIEW_BYTES}-byte preview limit`,
    );
  }

  return {
    artifactId,
    mimeType: payload.mimeType,
    dataUrl: `data:${payload.mimeType};base64,${Buffer.from(payload.bytes).toString('base64')}`,
  };
}
