import type OpenAI from 'openai';
import type { ArtifactReader } from '../../execution/artifact-port.js';
import type { ImageRequest } from '../../image/contracts.js';

export async function mapOpenRouterImageRequest(
  request: ImageRequest,
  upstreamModel: string,
  outputModalities: readonly string[],
  artifacts: ArtifactReader | undefined,
  signal: AbortSignal,
): Promise<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming> {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [];
  if (request.operation.kind === 'edit') {
    if (!artifacts) throw new Error('OpenRouter image edits require an Artifact Reader');
    for (const source of request.operation.sources) {
      const payload = await artifacts.read(source, signal);
      content.push({
        type: 'image_url',
        image_url: { url: `data:${payload.mimeType};base64,${Buffer.from(payload.bytes).toString('base64')}` },
      });
    }
    if (request.operation.mask) {
      const mask = await artifacts.read(request.operation.mask, signal);
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mask.mimeType};base64,${Buffer.from(mask.bytes).toString('base64')}` },
      });
    }
  }
  content.push({ type: 'text', text: request.operation.prompt });

  const imageOnly = outputModalities.length === 1 && outputModalities[0] === 'image';
  return {
    model: upstreamModel,
    messages: [{ role: 'user', content }],
    modalities: imageOnly ? ['image'] : ['image', 'text'],
  } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}
