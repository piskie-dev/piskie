import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { CatalogSnapshot, ModelDefinition } from '../../../catalog/contracts.js';
import type { ProviderInstance } from '../../../control/config-schema.js';
import { ComfyWorkflowAssetStore, type ComfyWorkflow } from '../../../control/workflow-assets.js';
import { GatewayCallError } from '../../../execution/call-error.js';
import type { AttemptContext } from '../../../execution/contracts.js';
import { MemoryArtifactStore } from '../../../image/artifact-store.js';
import type { ImageRequest } from '../../../image/contracts.js';
import { ImageSubmissionError, type ImageAttemptEvent } from '../../../image/driver-port.js';
import { createComfyWorkflowDriver } from '../driver.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface FakeComfyServer {
  baseUrl: string;
  webSockets: WebSocketServer;
}

async function serve(handler: http.RequestListener): Promise<FakeComfyServer> {
  const server = http.createServer(handler);
  const webSockets = new WebSocketServer({ server, path: '/ws' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake ComfyUI server did not bind a TCP port');
  cleanups.push(async () => {
    for (const client of webSockets.clients) client.terminate();
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, webSockets };
}

async function fixture(): Promise<{
  workflows: ComfyWorkflowAssetStore;
  artifacts: MemoryArtifactStore;
  assetId: string;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-comfy-driver-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const workflows = new ComfyWorkflowAssetStore(path.join(directory, 'workflows'));
  const workflow: ComfyWorkflow = {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'template prompt' } },
    '2': { class_type: 'KSampler', inputs: { seed: 1 } },
    '3': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '4': { class_type: 'LoadImage', inputs: { image: 'template-source.png' } },
    '5': { class_type: 'LoadImageMask', inputs: { image: 'template-mask.png' } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  };
  const asset = await workflows.import(workflow);
  return { workflows, artifacts: new MemoryArtifactStore(), assetId: asset.id };
}

function model(): ModelDefinition {
  return {
    id: 'custom/comfy-workflow',
    displayName: 'Local Comfy Workflow',
    kind: 'image',
    lifecycle: 'active',
    compatibleDrivers: ['comfyui-workflow'],
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    capabilities: { generate: true, edit: true, referenceImages: true, mask: true },
    limits: {},
    source: { kind: 'local', version: '1' },
  };
}

function provider(baseUrl: string, assetId: string): ProviderInstance {
  return {
    displayName: 'Fake ComfyUI',
    driver: 'comfyui-workflow',
    enabled: true,
    connection: {
      baseUrl,
      auth: { kind: 'bearer', value: 'plain-comfy-key' },
      headers: { 'X-Piskie-Test': 'comfy' },
      proxyId: null,
    },
    models: {
      workflow: {
        catalogId: 'custom/comfy-workflow',
        upstreamId: 'local-workflow',
        enabled: true,
        options: {
          workflowAssetId: assetId,
          bindings: {
            prompt: { nodeId: '1', field: 'text' },
            seed: { nodeId: '2', field: 'seed' },
            width: { nodeId: '3', field: 'width' },
            height: { nodeId: '3', field: 'height' },
            batch: { nodeId: '3', field: 'batch_size' },
            inputImages: [{ nodeId: '4', field: 'image' }],
            mask: { nodeId: '5', field: 'image' },
          },
          outputNodeIds: ['9'],
        },
      },
    },
    driverOptions: { historyPollIntervalMs: 25 },
  };
}

function catalog(definition: ModelDefinition): CatalogSnapshot {
  return {
    version: 'test',
    loadedAt: '2026-07-29T00:00:00.000Z',
    models: new Map([[definition.id, definition]]),
  };
}

function context(signal: AbortSignal = new AbortController().signal): AttemptContext {
  return {
    runId: 'run-comfy',
    traceId: 'trace-comfy',
    signal,
    attempt: 1,
    configRevision: 4,
    connectTimeoutMs: 1_000,
  };
}

function compile(
  configuredProvider: ProviderInstance,
  workflows: ComfyWorkflowAssetStore,
  artifacts: MemoryArtifactStore,
  uuid: () => string = () => 'client-fixed',
) {
  const definition = model();
  return createComfyWorkflowDriver({
    workflows,
    artifacts,
    uuid,
  }).compile({
    providerId: 'local-comfy',
    provider: configuredProvider,
    modelId: 'workflow',
    binding: configuredProvider.models.workflow!,
    catalogModel: definition,
    catalog: catalog(definition),
    configRevision: 4,
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

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('ComfyUI workflow Driver', () => {
  it('ignores unknown persisted options but still rejects invalid known options', async () => {
    const { workflows, artifacts, assetId } = await fixture();
    const configuredProvider = provider('http://127.0.0.1:1', assetId);
    configuredProvider.driverOptions = {
      historyPollIntervalMs: 25,
      futureProviderOption: true,
    };
    configuredProvider.models.workflow.options = {
      workflowAssetId: assetId,
      bindings: {
        prompt: { nodeId: '1', field: 'text', futureBindingField: true },
        futureBinding: true,
      },
      outputNodeIds: ['9'],
      futureModelOption: true,
    };
    const definition = model();
    const driver = createComfyWorkflowDriver({ workflows, artifacts });

    expect(driver.validateProviderOptions(configuredProvider.driverOptions)).toEqual([]);
    expect(driver.validateModelOptions(configuredProvider.models.workflow.options)).toEqual([]);
    expect(() => driver.compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'workflow',
      binding: configuredProvider.models.workflow,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 4,
    })).not.toThrow();
    expect(driver.validateProviderOptions({ historyPollIntervalMs: 1 })).toEqual([
      expect.objectContaining({ code: 'COMFYUI_OPTIONS_INVALID', path: '/historyPollIntervalMs' }),
    ]);
  });

  it('resolves HTTP and WebSocket transports from the same configured proxy', async () => {
    const { workflows, artifacts, assetId } = await fixture();
    const configuredProvider = provider('http://127.0.0.1:1', assetId);
    configuredProvider.connection.proxyId = 'proxy-comfy';
    const resolveFetch = vi.fn((_proxyId: string | null, fallback: typeof globalThis.fetch) => fallback);
    const resolveSocketFactory = vi.fn((_proxyId, fallback) => fallback);
    const definition = model();

    createComfyWorkflowDriver({
      workflows,
      artifacts,
      resolveFetch,
      resolveSocketFactory,
    }).compile({
      providerId: 'local-comfy',
      provider: configuredProvider,
      modelId: 'workflow',
      binding: configuredProvider.models.workflow!,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 4,
    });

    expect(resolveFetch).toHaveBeenCalledOnce();
    expect(resolveFetch).toHaveBeenCalledWith('proxy-comfy', globalThis.fetch);
    expect(resolveSocketFactory).toHaveBeenCalledOnce();
    expect(resolveSocketFactory).toHaveBeenCalledWith('proxy-comfy', expect.any(Function));
  });

  it('uploads edit inputs, submits once, projects WebSocket events, and downloads history outputs', async () => {
    const { workflows, artifacts, assetId } = await fixture();
    const source = await artifacts.write({
      bytes: Buffer.from('source-image'),
      mimeType: 'image/png',
      fileName: 'source original.png',
    });
    const mask = await artifacts.write({ bytes: Buffer.from('mask-image'), mimeType: 'image/png' });
    const uploadBodies: string[] = [];
    let promptCount = 0;
    let promptBody: Record<string, unknown> | undefined;
    let historyCount = 0;
    let viewQuery: URLSearchParams | undefined;
    const finalImage = pngHeader(64, 32);
    const fake = await serve(async (incoming, response) => {
      expect(incoming.headers.authorization).toBe('Bearer plain-comfy-key');
      expect(incoming.headers['x-piskie-test']).toBe('comfy');
      if (incoming.url === '/upload/image') {
        uploadBodies.push((await readRequest(incoming)).toString('latin1'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          name: `uploaded-${uploadBodies.length}.png`,
          subfolder: 'piskie-inputs',
          type: 'input',
        }));
        return;
      }
      if (incoming.url === '/prompt') {
        promptCount++;
        promptBody = JSON.parse((await readRequest(incoming)).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ prompt_id: 'prompt-one', number: 3 }));
        return;
      }
      if (incoming.url === '/history/prompt-one') {
        historyCount++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(historyCount === 1 ? '{}' : JSON.stringify({
          'prompt-one': {
            outputs: {
              '9': { images: [{ filename: 'final.png', subfolder: 'outputs', type: 'output' }] },
            },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        }));
        return;
      }
      if (incoming.url?.startsWith('/view?')) {
        viewQuery = new URL(incoming.url, fake.baseUrl).searchParams;
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(finalImage);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unexpected endpoint', path: incoming.url }));
    });
    let socketClientId: string | undefined;
    let socketAuth: string | undefined;
    fake.webSockets.on('connection', (socket, incoming) => {
      socketClientId = new URL(incoming.url ?? '/', fake.baseUrl).searchParams.get('clientId') ?? undefined;
      socketAuth = incoming.headers.authorization;
      setImmediate(() => {
        socket.send(JSON.stringify({
          type: 'status',
          data: { status: { exec_info: { queue_remaining: 1 } } },
        }));
        socket.send(JSON.stringify({
          type: 'progress',
          data: { prompt_id: 'prompt-one', node: '7', value: 1, max: 2 },
        }));
        socket.send(JSON.stringify({
          type: 'executing',
          data: { prompt_id: 'prompt-one', node: '8' },
        }));
        const preview = pngHeader(16, 8);
        const binary = Buffer.alloc(8 + preview.byteLength);
        binary.writeUInt32BE(1, 0);
        binary.writeUInt32BE(2, 4);
        preview.copy(binary, 8);
        socket.send(binary, { binary: true });
        socket.send(JSON.stringify({
          type: 'executing',
          data: { prompt_id: 'prompt-one', node: null },
        }));
      });
    });
    const configuredProvider = provider(fake.baseUrl, assetId);
    const target = compile(configuredProvider, workflows, artifacts);
    const request: ImageRequest = {
      model: { providerId: 'local-comfy', modelId: 'workflow' },
      operation: {
        kind: 'edit',
        prompt: 'replace the sky',
        sources: [source.ref],
        mask: mask.ref,
        count: 2,
        output: { width: 64, height: 32 },
      },
      extensions: { 'comfyui-workflow': { seed: 42 } },
    };

    const events = await collect(target.image!.submit(request, context()));

    expect(promptCount).toBe(1);
    expect(uploadBodies).toHaveLength(2);
    expect(uploadBodies[0]).toContain('filename="source_original.png"');
    expect(uploadBodies[0]).toContain('source-image');
    expect(uploadBodies[1]).toContain('filename="mask.png"');
    expect(uploadBodies[1]).toContain('mask-image');
    expect(socketClientId).toBe('client-fixed');
    expect(socketAuth).toBe('Bearer plain-comfy-key');
    expect(promptBody).toMatchObject({
      client_id: 'client-fixed',
      prompt: {
        '1': { inputs: { text: 'replace the sky' } },
        '2': { inputs: { seed: 42 } },
        '3': { inputs: { width: 64, height: 32, batch_size: 2 } },
        '4': { inputs: { image: 'piskie-inputs/uploaded-1.png' } },
        '5': { inputs: { image: 'piskie-inputs/uploaded-2.png' } },
      },
    });
    expect(workflows.readSync(assetId).workflow).toMatchObject({
      '1': { inputs: { text: 'template prompt' } },
      '2': { inputs: { seed: 1 } },
      '3': { inputs: { width: 512, height: 512, batch_size: 1 } },
      '4': { inputs: { image: 'template-source.png' } },
      '5': { inputs: { image: 'template-mask.png' } },
    });
    expect(events[0]).toEqual({
      kind: 'job.accepted',
      upstreamJobId: 'prompt-one',
      resumable: true,
      position: 3,
      driverState: { clientId: 'client-fixed', seed: 42 },
    });
    expect(events.map((event) => event.kind)).toEqual([
      'job.accepted',
      'progress',
      'progress',
      'progress',
      'preview',
      'artifact',
      'completed',
    ]);
    expect(events.find((event) => event.kind === 'preview')).toMatchObject({
      artifact: { mimeType: 'image/png', width: 16, height: 8, seed: 42 },
    });
    expect(events.find((event) => event.kind === 'artifact')).toMatchObject({
      artifact: {
        mimeType: 'image/png',
        width: 64,
        height: 32,
        byteLength: finalImage.byteLength,
        seed: 42,
      },
    });
    expect(events.at(-1)).toEqual({ kind: 'completed', usage: { imageCount: 1 } });
    expect(Object.fromEntries(viewQuery ?? [])).toEqual({
      filename: 'final.png',
      subfolder: 'outputs',
      type: 'output',
    });
  });

  it('falls back to history after a WebSocket disconnect without resubmitting the prompt', async () => {
    const { workflows, artifacts, assetId } = await fixture();
    let promptCount = 0;
    let historyCount = 0;
    const fake = await serve(async (incoming, response) => {
      if (incoming.url === '/prompt') {
        promptCount++;
        await readRequest(incoming);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ prompt_id: 'disconnected-job' }));
        return;
      }
      if (incoming.url === '/history/disconnected-job') {
        historyCount++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(historyCount === 1 ? '{}' : JSON.stringify({
          'disconnected-job': {
            outputs: { '9': { images: [{ filename: 'done.png', type: 'output' }] } },
            status: { status_str: 'success', completed: true },
          },
        }));
        return;
      }
      if (incoming.url?.startsWith('/view?')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(pngHeader(32, 32));
        return;
      }
      response.writeHead(404).end();
    });
    fake.webSockets.on('connection', (socket) => socket.close(1011, 'simulated disconnect'));
    const target = compile(provider(fake.baseUrl, assetId), workflows, artifacts);
    const request: ImageRequest = {
      model: { providerId: 'local-comfy', modelId: 'workflow' },
      operation: { kind: 'generate', prompt: 'one image' },
    };

    const events = await collect(target.image!.submit(request, context()));

    expect(promptCount).toBe(1);
    expect(historyCount).toBe(2);
    expect(events.map((event) => event.kind)).toEqual(['job.accepted', 'artifact', 'completed']);
  });

  it('resumes an existing prompt ID through history and has no code path that posts a prompt', async () => {
    const { workflows, artifacts, assetId } = await fixture();
    let promptCount = 0;
    const fake = await serve(async (incoming, response) => {
      if (incoming.url === '/prompt') {
        promptCount++;
        response.writeHead(500).end();
        return;
      }
      if (incoming.url === '/history/existing-job') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          'existing-job': {
            outputs: { '9': { images: [{ filename: 'resumed.png', type: 'output' }] } },
            status: { status_str: 'success', completed: true },
          },
        }));
        return;
      }
      if (incoming.url?.startsWith('/view?')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(pngHeader(20, 10));
        return;
      }
      response.writeHead(404).end();
    });
    const target = compile(provider(fake.baseUrl, assetId), workflows, artifacts);
    const request: ImageRequest = {
      model: { providerId: 'local-comfy', modelId: 'workflow' },
      operation: { kind: 'generate', prompt: 'already submitted' },
    };

    const events = await collect(target.image!.resume!({
      job: {
        journalId: '00000000-0000-4000-8000-000000000000',
        providerId: 'local-comfy',
        modelId: 'workflow',
        driverId: 'comfyui-workflow',
        configRevision: 4,
        upstreamJobId: 'existing-job',
        resumable: true,
      },
      request,
      driverState: { clientId: 'original-client', seed: 7 },
    }, context()));

    expect(promptCount).toBe(0);
    expect(events.map((event) => event.kind)).toEqual(['artifact', 'completed']);
    expect(events[0]).toMatchObject({ artifact: { width: 20, height: 10, seed: 7 } });
  });

  it('preserves prompt node_errors and execution_error bodies without a hidden resubmit', async () => {
    const first = await fixture();
    let rejectedPromptCount = 0;
    const rejected = await serve(async (incoming, response) => {
      if (incoming.url === '/prompt') {
        rejectedPromptCount++;
        await readRequest(incoming);
        response.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'comfy-node-error' });
        response.end(JSON.stringify({
          error: { type: 'prompt_outputs_failed_validation', message: 'Prompt validation failed' },
          node_errors: { '7': { errors: [{ type: 'value_not_in_list', message: 'bad checkpoint' }] } },
        }));
        return;
      }
      response.writeHead(404).end();
    });
    const rejectedTarget = compile(provider(rejected.baseUrl, first.assetId), first.workflows, first.artifacts);
    const request: ImageRequest = {
      model: { providerId: 'local-comfy', modelId: 'workflow' },
      operation: { kind: 'generate', prompt: 'invalid workflow values' },
    };
    let promptFailure: unknown;
    try {
      await collect(rejectedTarget.image!.submit(request, context()));
    } catch (cause) {
      promptFailure = cause;
    }
    expect(rejectedPromptCount).toBe(1);
    expect(promptFailure).toBeInstanceOf(ImageSubmissionError);
    expect(promptFailure).toMatchObject({
      message: 'Prompt validation failed',
      submissionState: 'rejected',
      retryable: false,
      upstream: {
        status: 400,
        type: 'prompt_outputs_failed_validation',
        requestId: 'comfy-node-error',
        body: {
          node_errors: { '7': { errors: [{ type: 'value_not_in_list', message: 'bad checkpoint' }] } },
        },
      },
    });

    const second = await fixture();
    let acceptedPromptCount = 0;
    let historyCount = 0;
    const accepted = await serve(async (incoming, response) => {
      if (incoming.url === '/prompt') {
        acceptedPromptCount++;
        await readRequest(incoming);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ prompt_id: 'execution-failure' }));
        return;
      }
      if (incoming.url === '/history/execution-failure') {
        historyCount++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(404).end();
    });
    accepted.webSockets.on('connection', (socket) => {
      setImmediate(() => socket.send(JSON.stringify({
        type: 'execution_error',
        data: {
          prompt_id: 'execution-failure',
          node_id: '8',
          exception_type: 'RuntimeError',
          exception_message: 'CUDA out of memory',
          traceback: ['line one', 'line two'],
        },
      })));
    });
    const acceptedTarget = compile(provider(accepted.baseUrl, second.assetId), second.workflows, second.artifacts);
    let executionFailure: unknown;
    try {
      await collect(acceptedTarget.image!.submit(request, context()));
    } catch (cause) {
      executionFailure = cause;
    }
    expect(acceptedPromptCount).toBe(1);
    expect(historyCount).toBe(1);
    expect(executionFailure).toBeInstanceOf(GatewayCallError);
    expect(executionFailure).toMatchObject({
      source: 'provider',
      stage: 'execution',
      message: 'CUDA out of memory',
      upstream: {
        type: 'RuntimeError',
        body: {
          prompt_id: 'execution-failure',
          node_id: '8',
          traceback: ['line one', 'line two'],
        },
      },
    });
  });

  it('isolates concurrent client IDs, prompt IDs, workflow copies, and progress streams', async () => {
    const { workflows, artifacts, assetId } = await fixture();
    const promptBodies = new Map<string, Record<string, unknown>>();
    const historyCounts = new Map<string, number>();
    let promptCount = 0;
    const fake = await serve(async (incoming, response) => {
      if (incoming.url === '/prompt') {
        promptCount++;
        const body = JSON.parse((await readRequest(incoming)).toString('utf8')) as Record<string, unknown>;
        const clientId = String(body.client_id);
        promptBodies.set(clientId, body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ prompt_id: `job-${clientId}` }));
        return;
      }
      if (incoming.url?.startsWith('/history/job-')) {
        const promptId = decodeURIComponent(incoming.url.slice('/history/'.length));
        const count = (historyCounts.get(promptId) ?? 0) + 1;
        historyCounts.set(promptId, count);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(count === 1 ? '{}' : JSON.stringify({
          [promptId]: {
            outputs: { '9': { images: [{ filename: `${promptId}.png`, type: 'output' }] } },
            status: { status_str: 'success', completed: true },
          },
        }));
        return;
      }
      if (incoming.url?.startsWith('/view?')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(pngHeader(12, 6));
        return;
      }
      response.writeHead(404).end();
    });
    fake.webSockets.on('connection', (socket, incoming) => {
      const clientId = new URL(incoming.url ?? '/', fake.baseUrl).searchParams.get('clientId')!;
      const promptId = `job-${clientId}`;
      setImmediate(() => {
        socket.send(JSON.stringify({
          type: 'progress',
          data: { prompt_id: `job-not-${clientId}`, value: 99, max: 100 },
        }));
        socket.send(JSON.stringify({
          type: 'progress',
          data: { prompt_id: promptId, value: 1, max: 4 },
        }));
        socket.send(JSON.stringify({ type: 'executing', data: { prompt_id: promptId, node: null } }));
      });
    });
    let clientSequence = 0;
    const target = compile(
      provider(fake.baseUrl, assetId),
      workflows,
      artifacts,
      () => `client-${++clientSequence}`,
    );
    const makeRequest = (prompt: string): ImageRequest => ({
      model: { providerId: 'local-comfy', modelId: 'workflow' },
      operation: { kind: 'generate', prompt },
    });

    const [first, second] = await Promise.all([
      collect(target.image!.submit(makeRequest('first prompt'), context())),
      collect(target.image!.submit(makeRequest('second prompt'), context())),
    ]);

    expect(promptCount).toBe(2);
    expect([...promptBodies.keys()].sort()).toEqual(['client-1', 'client-2']);
    expect(promptBodies.get('client-1')).toMatchObject({ prompt: { '1': { inputs: { text: 'first prompt' } } } });
    expect(promptBodies.get('client-2')).toMatchObject({ prompt: { '1': { inputs: { text: 'second prompt' } } } });
    for (const events of [first, second]) {
      expect(events.filter((event) => event.kind === 'progress')).toEqual([{
        kind: 'progress',
        value: 0.25,
      }]);
      expect(events.map((event) => event.kind)).toEqual(['job.accepted', 'progress', 'artifact', 'completed']);
    }
    expect(first[0]).toMatchObject({ upstreamJobId: 'job-client-1' });
    expect(second[0]).toMatchObject({ upstreamJobId: 'job-client-2' });
  });

  it('aborts observation by closing only its socket and never calls a global interrupt endpoint', async () => {
    const { workflows, artifacts, assetId } = await fixture();
    const requestedPaths: string[] = [];
    let promptCount = 0;
    const fake = await serve(async (incoming, response) => {
      requestedPaths.push(incoming.url ?? '');
      if (incoming.url === '/prompt') {
        promptCount++;
        await readRequest(incoming);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ prompt_id: 'cancelled-locally' }));
        return;
      }
      if (incoming.url === '/history/cancelled-locally') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(404).end();
    });
    let connectedResolve: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => { connectedResolve = resolve; });
    let closedResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => { closedResolve = resolve; });
    fake.webSockets.on('connection', (socket) => {
      connectedResolve?.();
      socket.once('close', () => closedResolve?.());
    });
    const target = compile(provider(fake.baseUrl, assetId), workflows, artifacts);
    const controller = new AbortController();
    const request: ImageRequest = {
      model: { providerId: 'local-comfy', modelId: 'workflow' },
      operation: { kind: 'generate', prompt: 'cancel after acceptance' },
    };
    const iterator = target.image!.submit(request, context(controller.signal))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: 'job.accepted', upstreamJobId: 'cancelled-locally' },
    });
    const observing = iterator.next();
    await connected;
    controller.abort(new Error('test cancellation'));
    await expect(observing).rejects.toThrow('test cancellation');
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WebSocket did not close')), 1_000)),
    ]);

    expect(promptCount).toBe(1);
    expect(requestedPaths.some((value) => value.includes('interrupt'))).toBe(false);
  });

  it('keeps already stored artifacts when a later ComfyUI view download fails', async () => {
    const { workflows, artifacts, assetId } = await fixture();
    let promptCount = 0;
    const fake = await serve(async (incoming, response) => {
      if (incoming.url === '/prompt') {
        promptCount++;
        await readRequest(incoming);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ prompt_id: 'partial-artifacts' }));
        return;
      }
      if (incoming.url === '/history/partial-artifacts') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          'partial-artifacts': {
            outputs: {
              '9': {
                images: [
                  { filename: 'first.png', type: 'output' },
                  { filename: 'second.png', type: 'output' },
                ],
              },
            },
            status: { status_str: 'success', completed: true },
          },
        }));
        return;
      }
      if (incoming.url?.includes('filename=first.png')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(pngHeader(30, 15));
        return;
      }
      if (incoming.url?.includes('filename=second.png')) {
        response.writeHead(502, { 'content-type': 'application/json', 'x-request-id': 'view-502' });
        response.end(JSON.stringify({ error: { message: 'output storage unavailable', type: 'storage_error' } }));
        return;
      }
      response.writeHead(404).end();
    });
    const target = compile(provider(fake.baseUrl, assetId), workflows, artifacts);
    const request: ImageRequest = {
      model: { providerId: 'local-comfy', modelId: 'workflow' },
      operation: { kind: 'generate', prompt: 'two outputs' },
    };
    const events: ImageAttemptEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of target.image!.submit(request, context())) events.push(event);
    } catch (cause) {
      failure = cause;
    }

    expect(promptCount).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(['job.accepted', 'artifact']);
    expect(events[1]).toMatchObject({ artifact: { width: 30, height: 15 } });
    expect(failure).toBeInstanceOf(GatewayCallError);
    expect(failure).toMatchObject({
      source: 'provider',
      stage: 'artifact_download',
      message: 'output storage unavailable',
      upstream: {
        status: 502,
        type: 'storage_error',
        requestId: 'view-502',
        body: { error: { message: 'output storage unavailable', type: 'storage_error' } },
      },
    });
  });
});
