import { GatewayCallError } from '../execution/call-error.js';
import type { ModelTarget } from '../execution/contracts.js';
import type { ImageArtifact, ImageEvent, ImageResult, ImageUsage } from './contracts.js';

export async function collectImageResult(
  events: AsyncIterable<ImageEvent>,
  expectedModel: ModelTarget,
  traceId: string,
): Promise<ImageResult> {
  let runId = '';
  let configRevision = 0;
  let artifacts: readonly ImageArtifact[] = [];
  let usage: ImageUsage = {};
  let job: ImageResult['job'];
  let completed = false;

  for await (const event of events) {
    runId = event.runId;
    switch (event.kind) {
      case 'image.submitting':
        configRevision = event.configRevision;
        break;
      case 'image.queued':
        job = event.job;
        configRevision = event.job.configRevision;
        break;
      case 'image.completed':
        artifacts = event.artifacts;
        usage = event.usage;
        completed = true;
        break;
      case 'image.failed':
        throw event.error;
      case 'image.cancelled':
        throw new GatewayCallError({
          source: 'cancelled',
          gateway: 'image',
          providerId: expectedModel.providerId,
          modelId: expectedModel.modelId,
          driverId: 'inference-core',
          stage: 'run',
          attempt: 0,
          traceId,
          message: 'Image request cancelled',
          localCode: 'IMAGE_REQUEST_CANCELLED',
        });
      case 'image.artifact':
      case 'image.preview':
      case 'image.progress':
        break;
    }
  }
  if (!completed) {
    throw new GatewayCallError({
      source: 'local',
      gateway: 'image',
      providerId: expectedModel.providerId,
      modelId: expectedModel.modelId,
      driverId: 'inference-core',
      stage: 'collect',
      attempt: 0,
      traceId,
      message: 'Image event stream ended without a completion event',
      localCode: 'IMAGE_RESULT_INCOMPLETE',
    });
  }
  return {
    runId,
    model: expectedModel,
    configRevision,
    artifacts,
    usage,
    ...(job && { job }),
  };
}
