import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogSnapshot, ModelDefinition } from '../../catalog/contracts.js';
import type { ProviderInstance, PlainAuth } from '../../control/config-schema.js';
import type { AttemptContext } from '../../execution/contracts.js';
import { MemoryArtifactStore } from '../../image/artifact-store.js';
import type { ImageRequest } from '../../image/contracts.js';
import { ImageSubmissionError, type ImageAttemptEvent } from '../../image/driver-port.js';
import { createBaiduImageDriver } from '../baidu-image/driver.js';
import { createDashScopeImageDriver } from '../dashscope-image/driver.js';
import { createGeminiImageDriver } from '../gemini-image/driver.js';
import { createOpenRouterImageDriver } from '../openrouter-image/driver.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Image wire test server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function readRequest(incoming: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJsonRequest(incoming: http.IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse((await readRequest(incoming)).toString('utf8')) as Record<string, unknown>;
}

function model(driverId: string, outputModalities: string[] = ['image']): ModelDefinition {
  return {
    id: `custom/${driverId}`,
    displayName: `Test ${driverId}`,
    kind: 'image',
    lifecycle: 'active',
    compatibleDrivers: [driverId],
    inputModalities: ['text', 'image'],
    outputModalities,
    capabilities: { generate: true, edit: true, referenceImages: true, mask: true },
    limits: {},
    source: { kind: 'local', version: '1' },
  };
}

function catalog(definition: ModelDefinition): CatalogSnapshot {
  return {
    version: 'wire-test',
    loadedAt: '2026-08-04T00:00:00.000Z',
    models: new Map([[definition.id, definition]]),
  };
}

function provider(
  driverId: string,
  baseUrl: string,
  auth: PlainAuth = { kind: 'bearer', value: 'plain-image-key' },
  driverOptions: Record<string, unknown> = {},
): ProviderInstance {
  return {
    displayName: `Test ${driverId}`,
    driver: driverId,
    enabled: true,
    connection: {
      baseUrl,
      auth,
      headers: { 'X-Piskie-Test': driverId },
      proxyId: null,
    },
    models: {
      image: {
        catalogId: `custom/${driverId}`,
        upstreamId: 'wire-selected-image-model',
        enabled: true,
        options: {},
      },
    },
    driverOptions,
  };
}

function compileInput(configuredProvider: ProviderInstance, definition: ModelDefinition) {
  return {
    providerId: 'provider',
    provider: configuredProvider,
    modelId: 'image',
    binding: configuredProvider.models.image!,
    catalogModel: definition,
    catalog: catalog(definition),
    configRevision: 7,
  };
}

function context(): AttemptContext {
  return {
    runId: 'run-image-wire',
    traceId: 'trace-image-wire',
    signal: new AbortController().signal,
    attempt: 1,
    configRevision: 7,
    connectTimeoutMs: 1_000,
  };
}

function generateRequest(prompt = 'Draw Piskie'): ImageRequest {
  return {
    model: { providerId: 'provider', modelId: 'image' },
    operation: {
      kind: 'generate',
      prompt,
      count: 1,
      output: { width: 1024, height: 1024 },
    },
  };
}

async function collect(events: AsyncIterable<ImageAttemptEvent>): Promise<ImageAttemptEvent[]> {
  const collected: ImageAttemptEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('DashScope image wire protocol', () => {
  it('submits once, polls PENDING/RUNNING/SUCCEEDED, downloads the URL, and stores the artifact', async () => {
    const pixels = Buffer.from('dashscope-image-bytes');
    let origin = '';
    let submitCount = 0;
    let pollCount = 0;
    let downloadCount = 0;
    let submitBody: Record<string, unknown> | undefined;
    let submitHeaders: http.IncomingHttpHeaders | undefined;
    origin = await serve(async (incoming, response) => {
      if (incoming.method === 'POST') {
        submitCount++;
        expect(incoming.url).toBe('/api/v1/services/aigc/image-generation/generation');
        submitHeaders = incoming.headers;
        submitBody = await readJsonRequest(incoming);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ output: { task_id: 'dash-task-1' }, request_id: 'dash-submit-1' }));
        return;
      }
      if (incoming.url === '/api/v1/tasks/dash-task-1') {
        pollCount++;
        const status = ['PENDING', 'RUNNING', 'SUCCEEDED'][pollCount - 1];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(status === 'SUCCEEDED'
          ? {
              output: { task_status: status, results: [{ url: `${origin}/result.png` }] },
              usage: { image_count: 1 },
              request_id: 'dash-poll-3',
            }
          : { output: { task_status: status }, request_id: `dash-poll-${pollCount}` }));
        return;
      }
      if (incoming.url === '/result.png') {
        downloadCount++;
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(pixels);
        return;
      }
      response.writeHead(404).end();
    });
    const artifacts = new MemoryArtifactStore();
    const definition = model('dashscope-image');
    const configuredProvider = provider('dashscope-image', origin, undefined, { pollIntervalMs: 100 });
    const target = createDashScopeImageDriver({
      artifacts,
      imageArtifacts: artifacts,
      sleep: async () => undefined,
    }).compile(compileInput(configuredProvider, definition));

    const events = await collect(target.image!.submit(generateRequest(), context()));

    expect(submitCount).toBe(1);
    expect(pollCount).toBe(3);
    expect(downloadCount).toBe(1);
    expect(submitHeaders).toMatchObject({
      authorization: 'Bearer plain-image-key',
      'content-type': 'application/json',
      'x-piskie-test': 'dashscope-image',
      'x-dashscope-async': 'enable',
    });
    expect(submitBody).toEqual({
      model: 'wire-selected-image-model',
      input: { messages: [{ role: 'user', content: [{ text: 'Draw Piskie' }] }] },
      parameters: { n: 1, size: '1024*1024' },
    });
    expect(events.map((event) => event.kind)).toEqual([
      'job.accepted',
      'progress',
      'progress',
      'artifact',
      'completed',
    ]);
    expect(events[1]).toEqual({ kind: 'progress', value: 0, message: 'PENDING' });
    expect(events[2]).toEqual({ kind: 'progress', value: 0.5, message: 'RUNNING' });
    const artifactEvent = events[3];
    if (artifactEvent?.kind !== 'artifact') throw new Error('Expected DashScope artifact event');
    await expect(artifacts.read({ artifactId: artifactEvent.artifact.artifactId })).resolves.toMatchObject({
      bytes: new Uint8Array(pixels),
      mimeType: 'image/png',
    });
  });

  it('resumes an accepted job by polling only and never submits it a second time', async () => {
    let postCount = 0;
    let getCount = 0;
    const baseUrl = await serve(async (incoming, response) => {
      if (incoming.method === 'POST') postCount++;
      if (incoming.method === 'GET' && incoming.url === '/api/v1/tasks/dash-resume-1') {
        getCount++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          output: {
            task_status: 'SUCCEEDED',
            results: [{ b64_image: Buffer.from('resumed-image').toString('base64') }],
          },
        }));
        return;
      }
      response.writeHead(404).end();
    });
    const artifacts = new MemoryArtifactStore();
    const definition = model('dashscope-image');
    const configuredProvider = provider('dashscope-image', baseUrl, undefined, { pollIntervalMs: 100 });
    const target = createDashScopeImageDriver({
      artifacts,
      imageArtifacts: artifacts,
      sleep: async () => undefined,
    }).compile(compileInput(configuredProvider, definition));
    const request = generateRequest('Resume Piskie');

    const events = await collect(target.image!.resume!({
      job: {
        journalId: 'journal-1',
        providerId: 'provider',
        modelId: 'image',
        driverId: 'dashscope-image',
        configRevision: 7,
        upstreamJobId: 'dash-resume-1',
        resumable: true,
      },
      request,
    }, context()));

    expect(postCount).toBe(0);
    expect(getCount).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(['artifact', 'completed']);
  });

  it('preserves the complete provider failure body', async () => {
    let requestCount = 0;
    const baseUrl = await serve(async (incoming, response) => {
      requestCount++;
      await readRequest(incoming);
      response.writeHead(429, { 'content-type': 'application/json', 'x-request-id': 'dash-http-429' });
      response.end(JSON.stringify({
        code: 'QuotaExceeded',
        message: 'dashscope rejected verbatim',
        request_id: 'dash-body-429',
        vendor_detail: { remaining: 0 },
      }));
    });
    const artifacts = new MemoryArtifactStore();
    const definition = model('dashscope-image');
    const target = createDashScopeImageDriver({ artifacts, imageArtifacts: artifacts }).compile(
      compileInput(provider('dashscope-image', baseUrl, undefined, { pollIntervalMs: 100 }), definition),
    );

    let failure: unknown;
    try {
      await collect(target.image!.submit(generateRequest(), context()));
    } catch (cause) {
      failure = cause;
    }

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(ImageSubmissionError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: 'dashscope rejected verbatim',
      submissionState: 'rejected',
      upstream: {
        status: 429,
        requestId: 'dash-http-429',
        code: 'QuotaExceeded',
        body: {
          code: 'QuotaExceeded',
          message: 'dashscope rejected verbatim',
          request_id: 'dash-body-429',
          vendor_detail: { remaining: 0 },
        },
      },
    });
  });
});

describe('Baidu Qianfan V2 image wire protocol', () => {
  it('sends generation JSON to V2 and stores base64 output', async () => {
    const pixels = Buffer.from('baidu-base64-image');
    let receivedBody: Record<string, unknown> | undefined;
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      expect(incoming.url).toBe('/v2/images/generations');
      receivedHeaders = incoming.headers;
      receivedBody = await readJsonRequest(incoming);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'baidu-image-1',
        data: [{ b64_json: pixels.toString('base64'), revised_prompt: 'Piskie revised' }],
      }));
    });
    const artifacts = new MemoryArtifactStore();
    const definition = model('baidu-image');
    const target = createBaiduImageDriver({ artifacts, imageArtifacts: artifacts }).compile(
      compileInput(provider('baidu-image', baseUrl), definition),
    );

    const events = await collect(target.image!.submit(generateRequest(), context()));

    expect(receivedHeaders).toMatchObject({
      authorization: 'Bearer plain-image-key',
      'content-type': 'application/json',
      'x-piskie-test': 'baidu-image',
    });
    expect(receivedBody).toEqual({
      model: 'wire-selected-image-model',
      prompt: 'Draw Piskie',
      n: 1,
      size: '1024x1024',
    });
    expect(events[0]).toMatchObject({
      kind: 'artifact',
      artifact: { mimeType: 'image/png', revisedPrompt: 'Piskie revised' },
    });
  });

  it('encodes edit sources and mask as data URLs and downloads URL output', async () => {
    const output = Buffer.from('baidu-url-image');
    let origin = '';
    let receivedBody: Record<string, unknown> | undefined;
    let downloadCount = 0;
    origin = await serve(async (incoming, response) => {
      if (incoming.url === '/v2/images/edits') {
        receivedBody = await readJsonRequest(incoming);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ url: `${origin}/baidu-result.webp` }] }));
        return;
      }
      if (incoming.url === '/baidu-result.webp') {
        downloadCount++;
        response.writeHead(200, { 'content-type': 'image/webp' });
        response.end(output);
        return;
      }
      response.writeHead(404).end();
    });
    const artifacts = new MemoryArtifactStore();
    const source = await artifacts.write({ bytes: Buffer.from('source-pixels'), mimeType: 'image/png' });
    const mask = await artifacts.write({ bytes: Buffer.from('mask-pixels'), mimeType: 'image/png' });
    const definition = model('baidu-image');
    const target = createBaiduImageDriver({ artifacts, imageArtifacts: artifacts }).compile(
      compileInput(provider('baidu-image', origin), definition),
    );
    const request: ImageRequest = {
      model: { providerId: 'provider', modelId: 'image' },
      operation: {
        kind: 'edit',
        prompt: 'Edit Piskie',
        sources: [source.ref],
        mask: mask.ref,
      },
    };

    const events = await collect(target.image!.submit(request, context()));

    expect(receivedBody).toEqual({
      model: 'wire-selected-image-model',
      prompt: 'Edit Piskie',
      image: `data:image/png;base64,${Buffer.from('source-pixels').toString('base64')}`,
      mask: `data:image/png;base64,${Buffer.from('mask-pixels').toString('base64')}`,
    });
    expect(downloadCount).toBe(1);
    expect(events[0]).toMatchObject({
      kind: 'artifact',
      artifact: { mimeType: 'image/webp', byteLength: output.byteLength },
    });
  });

  it('preserves Qianfan provider errors without an extra request', async () => {
    let requestCount = 0;
    const baseUrl = await serve(async (incoming, response) => {
      requestCount++;
      await readRequest(incoming);
      response.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'baidu-request-400' });
      response.end(JSON.stringify({
        code: 'InvalidParameter',
        message: 'baidu rejected verbatim',
        type: 'invalid_request_error',
        vendor_detail: { field: 'size' },
      }));
    });
    const artifacts = new MemoryArtifactStore();
    const definition = model('baidu-image');
    const target = createBaiduImageDriver({ artifacts, imageArtifacts: artifacts }).compile(
      compileInput(provider('baidu-image', baseUrl), definition),
    );

    let failure: unknown;
    try {
      await collect(target.image!.submit(generateRequest(), context()));
    } catch (cause) {
      failure = cause;
    }

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(ImageSubmissionError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: 'baidu rejected verbatim',
      upstream: {
        status: 400,
        requestId: 'baidu-request-400',
        code: 'InvalidParameter',
        type: 'invalid_request_error',
        body: {
          code: 'InvalidParameter',
          message: 'baidu rejected verbatim',
          type: 'invalid_request_error',
          vendor_detail: { field: 'size' },
        },
      },
    });
  });
});

describe('Gemini native image wire protocol', () => {
  it('calls generateContent with x-goog-api-key and stores inlineData output', async () => {
    const pixels = Buffer.from('gemini-inline-image');
    let receivedBody: Record<string, unknown> | undefined;
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      expect(incoming.url).toBe('/v1beta/models/wire-selected-image-model:generateContent');
      receivedHeaders = incoming.headers;
      receivedBody = await readJsonRequest(incoming);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { text: 'Piskie revised' },
              { inlineData: { mimeType: 'image/webp', data: pixels.toString('base64') } },
            ],
          },
        }],
      }));
    });
    const artifacts = new MemoryArtifactStore();
    const definition = model('gemini-image');
    const configuredProvider = provider(
      'gemini-image',
      baseUrl,
      { kind: 'api_key', header: 'x-goog-api-key', value: 'plain-gemini-key' },
    );
    const target = createGeminiImageDriver({ artifacts, imageArtifacts: artifacts }).compile(
      compileInput(configuredProvider, definition),
    );

    const events = await collect(target.image!.submit(generateRequest(), context()));

    expect(receivedHeaders).toMatchObject({
      'content-type': 'application/json',
      'x-piskie-test': 'gemini-image',
      'x-goog-api-key': 'plain-gemini-key',
    });
    expect(receivedHeaders?.authorization).toBeUndefined();
    expect(receivedBody).toEqual({
      contents: [{ parts: [{ text: 'Draw Piskie' }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '1024:1024' },
      },
    });
    expect(events[0]).toMatchObject({
      kind: 'artifact',
      artifact: {
        mimeType: 'image/webp',
        byteLength: pixels.byteLength,
        revisedPrompt: 'Piskie revised',
      },
    });
  });

  it('returns the raw Gemini error body', async () => {
    let requestCount = 0;
    const baseUrl = await serve(async (incoming, response) => {
      requestCount++;
      await readRequest(incoming);
      response.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'gemini-request-400' });
      response.end(JSON.stringify({
        error: {
          code: 400,
          message: 'gemini rejected verbatim',
          status: 'INVALID_ARGUMENT',
          details: [{ reason: 'IMAGE_SAFETY' }],
        },
      }));
    });
    const artifacts = new MemoryArtifactStore();
    const definition = model('gemini-image');
    const configuredProvider = provider(
      'gemini-image',
      baseUrl,
      { kind: 'api_key', header: 'x-goog-api-key', value: 'plain-gemini-key' },
    );
    const target = createGeminiImageDriver({ artifacts, imageArtifacts: artifacts }).compile(
      compileInput(configuredProvider, definition),
    );

    let failure: unknown;
    try {
      await collect(target.image!.submit(generateRequest(), context()));
    } catch (cause) {
      failure = cause;
    }

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(ImageSubmissionError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: 'gemini rejected verbatim',
      upstream: {
        status: 400,
        requestId: 'gemini-request-400',
        body: {
          error: {
            code: 400,
            message: 'gemini rejected verbatim',
            status: 'INVALID_ARGUMENT',
            details: [{ reason: 'IMAGE_SAFETY' }],
          },
        },
      },
    });
  });
});

describe('OpenRouter image wire protocol', () => {
  it('uses chat/completions, exact selected model and modalities, then stores message.images', async () => {
    const pixels = Buffer.from('openrouter-image');
    let receivedBody: Record<string, unknown> | undefined;
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      expect(incoming.url).toBe('/v1/chat/completions');
      receivedHeaders = incoming.headers;
      receivedBody = await readJsonRequest(incoming);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'openrouter-image-1',
        object: 'chat.completion',
        created: 1,
        model: 'wire-selected-image-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: null,
            images: [{
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${pixels.toString('base64')}` },
            }],
          },
        }],
      }));
    });
    const artifacts = new MemoryArtifactStore();
    const definition = model('openrouter-image', ['text', 'image']);
    const target = createOpenRouterImageDriver({ artifacts, imageArtifacts: artifacts }).compile(
      compileInput(provider('openrouter-image', `${baseUrl}/v1`), definition),
    );

    const events = await collect(target.image!.submit(generateRequest(), context()));

    expect(receivedHeaders).toMatchObject({
      authorization: 'Bearer plain-image-key',
      'content-type': 'application/json',
      'http-referer': 'https://piskie.dev',
      'x-title': 'Piskie',
      'x-piskie-test': 'openrouter-image',
    });
    expect(receivedBody).toMatchObject({
      model: 'wire-selected-image-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Draw Piskie' }] }],
      modalities: ['image', 'text'],
    });
    expect(events[0]).toMatchObject({
      kind: 'artifact',
      artifact: { mimeType: 'image/png', byteLength: pixels.byteLength },
    });
  });

  it('disables SDK retries and preserves the OpenRouter error body', async () => {
    let requestCount = 0;
    const baseUrl = await serve(async (incoming, response) => {
      requestCount++;
      await readRequest(incoming);
      response.writeHead(503, { 'content-type': 'application/json', 'x-request-id': 'openrouter-request-503' });
      response.end(JSON.stringify({
        error: {
          code: 503,
          message: 'openrouter rejected verbatim',
          metadata: { provider_name: 'upstream-image' },
        },
      }));
    });
    const artifacts = new MemoryArtifactStore();
    const definition = model('openrouter-image');
    const target = createOpenRouterImageDriver({ artifacts, imageArtifacts: artifacts }).compile(
      compileInput(provider('openrouter-image', `${baseUrl}/v1`), definition),
    );

    let failure: unknown;
    try {
      await collect(target.image!.submit(generateRequest(), context()));
    } catch (cause) {
      failure = cause;
    }

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(ImageSubmissionError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: 'openrouter rejected verbatim',
      submissionState: 'rejected',
      upstream: {
        status: 503,
        requestId: 'openrouter-request-503',
        body: {
          error: {
            code: 503,
            message: 'openrouter rejected verbatim',
            metadata: { provider_name: 'upstream-image' },
          },
        },
      },
    });
  });
});
