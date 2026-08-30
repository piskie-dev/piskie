import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogSnapshot, ModelDefinition } from '../../../catalog/contracts.js';
import type { ProviderInstance } from '../../../control/config-schema.js';
import type { AttemptContext } from '../../../execution/contracts.js';
import type { ImageRequest } from '../../../image/contracts.js';
import type { ImageAttemptEvent } from '../../../image/driver-port.js';
import { ImageSubmissionError } from '../../../image/driver-port.js';
import { MemoryArtifactStore } from '../../../image/artifact-store.js';
import { createOpenAiDriver } from '../driver.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function serve(handler: http.RequestListener): Promise<{ baseUrl: string; origin: string }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake OpenAI server did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  return { baseUrl: `${origin}/v1`, origin };
}

function imageModel(): ModelDefinition {
  return {
    id: 'openai/test-image',
    displayName: 'Test Image',
    kind: 'image',
    lifecycle: 'active',
    compatibleDrivers: ['openai'],
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    capabilities: { generate: true, edit: true, referenceImages: true, mask: true },
    limits: {},
    source: { kind: 'local', version: '1' },
  };
}

function catalog(definition: ModelDefinition): CatalogSnapshot {
  return {
    version: 'test',
    loadedAt: '2026-07-29T00:00:00.000Z',
    models: new Map([[definition.id, definition]]),
  };
}

function provider(baseUrl: string, options: Record<string, unknown> = {}): ProviderInstance {
  return {
    displayName: 'Fake OpenAI Images',
    driver: 'openai',
    enabled: true,
    connection: {
      baseUrl,
      auth: { kind: 'bearer', value: 'plain-image-key' },
      headers: { 'X-Piskie-Test': 'image' },
      proxyId: null,
    },
    models: {
      image: {
        catalogId: 'openai/test-image',
        upstreamId: 'wire-image-model',
        enabled: true,
        options,
      },
    },
    driverOptions: {},
  };
}

function attemptContext(): AttemptContext {
  return {
    runId: 'run-openai-image',
    traceId: 'trace-openai-image',
    signal: new AbortController().signal,
    attempt: 1,
    configRevision: 9,
    connectTimeoutMs: 1_000,
  };
}

function compileImageTarget(
  configuredProvider: ProviderInstance,
  artifacts: MemoryArtifactStore,
) {
  const definition = imageModel();
  return createOpenAiDriver({ artifacts, imageArtifacts: artifacts }).compile({
    providerId: 'provider',
    provider: configuredProvider,
    modelId: 'image',
    binding: configuredProvider.models.image!,
    catalogModel: definition,
    catalog: catalog(definition),
    configRevision: 9,
  });
}

async function collect(events: AsyncIterable<ImageAttemptEvent>): Promise<ImageAttemptEvent[]> {
  const result: ImageAttemptEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function readRequest(incoming: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('OpenAI SDK Images driver', () => {
  it('sends a JSON generation request to the exact selected model and stores base64 output', async () => {
    let requestCount = 0;
    let receivedBody: Record<string, unknown> | undefined;
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const pixels = Buffer.from('generated-image-bytes');
    const { baseUrl } = await serve(async (incoming, response) => {
      requestCount++;
      expect(incoming.url).toBe('/v1/images/generations');
      receivedHeaders = incoming.headers;
      receivedBody = JSON.parse((await readRequest(incoming)).toString('utf8')) as Record<string, unknown>;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        created: 1,
        data: [{ b64_json: pixels.toString('base64'), revised_prompt: 'revised prompt' }],
        output_format: 'png',
        size: '64x32',
        usage: { total_tokens: 17 },
      }));
    });
    const artifacts = new MemoryArtifactStore(() => new Date('2026-07-29T01:00:00.000Z'));
    const target = compileImageTarget(provider(baseUrl, { imageResponseFormat: 'b64_json' }), artifacts);
    const request: ImageRequest = {
      model: { providerId: 'provider', modelId: 'image' },
      operation: {
        kind: 'generate',
        prompt: 'draw one square',
        count: 1,
        output: { width: 64, height: 32, quality: 'high', format: 'png', background: 'transparent' },
      },
    };

    const events = await collect(target.image!.submit(request, attemptContext()));

    expect(requestCount).toBe(1);
    expect(receivedHeaders).toMatchObject({
      authorization: 'Bearer plain-image-key',
      'x-piskie-test': 'image',
      'content-type': 'application/json',
    });
    expect(receivedBody).toMatchObject({
      model: 'wire-image-model',
      prompt: 'draw one square',
      n: 1,
      size: '64x32',
      quality: 'high',
      output_format: 'png',
      background: 'transparent',
      response_format: 'b64_json',
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'artifact',
      artifact: {
        mimeType: 'image/png',
        width: 64,
        height: 32,
        byteLength: pixels.byteLength,
        revisedPrompt: 'revised prompt',
      },
    });
    expect(events[1]).toEqual({ kind: 'completed', usage: { imageCount: 1, providerUnits: 17 } });
    const artifactEvent = events[0];
    if (artifactEvent?.kind !== 'artifact') throw new Error('Expected an artifact event');
    await expect(artifacts.read({ artifactId: artifactEvent.artifact.artifactId }))
      .resolves.toMatchObject({ bytes: new Uint8Array(pixels), mimeType: 'image/png' });
  });

  it('downloads URL output once without issuing another generation request', async () => {
    let generationCount = 0;
    let downloadCount = 0;
    const downloaded = Buffer.from('downloaded-image');
    let origin = '';
    const server = await serve(async (incoming, response) => {
      if (incoming.url === '/v1/images/generations') {
        generationCount++;
        await readRequest(incoming);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ url: `${origin}/result.webp` }] }));
        return;
      }
      if (incoming.url === '/result.webp') {
        downloadCount++;
        response.writeHead(200, { 'content-type': 'image/webp' });
        response.end(downloaded);
        return;
      }
      response.writeHead(404).end();
    });
    origin = server.origin;
    const artifacts = new MemoryArtifactStore();
    const target = compileImageTarget(provider(server.baseUrl, { imageResponseFormat: 'url' }), artifacts);
    const request: ImageRequest = {
      model: { providerId: 'provider', modelId: 'image' },
      operation: { kind: 'generate', prompt: 'download this' },
    };

    const events = await collect(target.image!.submit(request, attemptContext()));

    expect(generationCount).toBe(1);
    expect(downloadCount).toBe(1);
    expect(events[0]).toMatchObject({
      kind: 'artifact',
      artifact: { mimeType: 'image/webp', byteLength: downloaded.byteLength },
    });
  });

  it('uses SDK multipart uploads for multiple edit sources and a mask', async () => {
    let requestCount = 0;
    let contentType = '';
    let multipartBody = '';
    const output = Buffer.from('edited-output');
    const { baseUrl } = await serve(async (incoming, response) => {
      requestCount++;
      expect(incoming.url).toBe('/v1/images/edits');
      contentType = incoming.headers['content-type'] ?? '';
      multipartBody = (await readRequest(incoming)).toString('latin1');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }));
    });
    const artifacts = new MemoryArtifactStore();
    const first = await artifacts.write({ bytes: Buffer.from('source-one'), mimeType: 'image/png' });
    const second = await artifacts.write({ bytes: Buffer.from('source-two'), mimeType: 'image/jpeg' });
    const mask = await artifacts.write({ bytes: Buffer.from('mask-bytes'), mimeType: 'image/png' });
    const target = compileImageTarget(provider(baseUrl, { imageResponseFormat: 'b64_json' }), artifacts);
    const request: ImageRequest = {
      model: { providerId: 'provider', modelId: 'image' },
      operation: {
        kind: 'edit',
        prompt: 'combine exactly these',
        sources: [first.ref, second.ref],
        mask: mask.ref,
        count: 2,
      },
    };

    await collect(target.image!.submit(request, attemptContext()));

    expect(requestCount).toBe(1);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(multipartBody).toContain('name="model"');
    expect(multipartBody).toContain('wire-image-model');
    expect(multipartBody).toContain('name="prompt"');
    expect(multipartBody).toContain('combine exactly these');
    expect(multipartBody.match(/name="image\[\]"/g)).toHaveLength(2);
    expect(multipartBody).toContain('filename="source-0.png"');
    expect(multipartBody).toContain('filename="source-1.jpg"');
    expect(multipartBody).toContain('name="mask"');
    expect(multipartBody).toContain('filename="mask.png"');
    expect(multipartBody).toContain('source-one');
    expect(multipartBody).toContain('source-two');
    expect(multipartBody).toContain('mask-bytes');
  });

  it('preserves a non-standard provider error and never relies on an SDK retry', async () => {
    let requestCount = 0;
    const { baseUrl } = await serve(async (incoming, response) => {
      requestCount++;
      await readRequest(incoming);
      response.writeHead(503, {
        'content-type': 'application/json',
        'x-request-id': 'image-request-503',
      });
      response.end(JSON.stringify({ detail: 'image backend warming up', extra: { queue: 7 } }));
    });
    const artifacts = new MemoryArtifactStore();
    const target = compileImageTarget(provider(baseUrl), artifacts);
    const request: ImageRequest = {
      model: { providerId: 'provider', modelId: 'image' },
      operation: { kind: 'generate', prompt: 'will fail' },
    };

    let failure: unknown;
    try {
      await collect(target.image!.submit(request, attemptContext()));
    } catch (cause) {
      failure = cause;
    }

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(ImageSubmissionError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: 'image backend warming up',
      submissionState: 'rejected',
      retryable: true,
      upstream: {
        status: 503,
        requestId: 'image-request-503',
        body: { detail: 'image backend warming up', extra: { queue: 7 } },
      },
    });
  });
});
