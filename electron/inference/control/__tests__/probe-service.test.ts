import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelDefinition } from '../../catalog/contracts.js';
import { createAnthropicMessagesDriver } from '../../drivers/anthropic-messages/driver.js';
import { createOpenAiDriver } from '../../drivers/openai/driver.js';
import { DriverRegistry } from '../../drivers/registry.js';
import type { InferenceRuntimeSnapshot } from '../../execution/runtime-snapshot.js';
import type { ImageRequest } from '../../image/contracts.js';
import { ImageJobJournal } from '../../image/job-journal.js';
import { compileInferenceConfig } from '../compiler.js';
import type { InferenceConfig } from '../config-schema.js';
import { InferenceProbeService } from '../probe-service.js';
import { testCatalog, testConfig, testModel } from './fixtures.js';

const servers: http.Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Probe test server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function readJsonRequest(incoming: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function writeAnthropicEvent(response: http.ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
}

function model(driverId: string, id: string, family: string): ModelDefinition {
  return testModel({
    id,
    family,
    compatibleDrivers: [driverId],
  });
}

function config(driverId: string, baseUrl: string, definition: ModelDefinition): InferenceConfig {
  const result = testConfig();
  const provider = result.providers.primary!;
  provider.driver = driverId;
  provider.connection.baseUrl = baseUrl;
  provider.connection.auth = { kind: 'bearer', value: 'plain-probe-key' };
  provider.models.chat!.catalogId = definition.id;
  provider.models.chat!.upstreamId = 'wire-probe-model';
  return result;
}

async function probeService(
  drivers: DriverRegistry,
  aiSmokeTimeoutMs = 500,
): Promise<InferenceProbeService> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-probe-service-'));
  temporaryDirectories.push(directory);
  return new InferenceProbeService({
    drivers,
    journal: new ImageJobJournal(path.join(directory, 'jobs')),
    aiSmokeTimeoutMs,
  });
}

describe('InferenceProbeService', () => {
  it('uses the compiled Image Gateway target for a real minimal generation smoke', async () => {
    let receivedRequest: ImageRequest | undefined;
    const snapshot: InferenceRuntimeSnapshot = {
      configRevision: 3,
      catalogVersion: 'image-test',
      targets: new Map([['primary', new Map([['image', {
        ref: { providerId: 'primary', modelId: 'image' },
        driverId: 'fake-image',
        upstreamModel: 'wire-image',
        catalogId: 'custom/image',
        configRevision: 3,
        modelDefinition: testModel({ id: 'custom/image', kind: 'image' }),
        image: {
          mode: 'synchronous',
          submit: async function* (request) {
            receivedRequest = request;
            yield {
              kind: 'artifact',
              artifact: {
                artifactId: `artifact:sha256:${'a'.repeat(64)}`,
                mimeType: 'image/png',
                width: 512,
                height: 512,
              },
            };
            yield { kind: 'completed', usage: { imageCount: 1 } };
          },
        },
      }]])]]),
      policies: {
        ai: {
          maxAttempts: 3,
          connectTimeoutMs: 30_000,
          streamIdleTimeoutMs: 300_000,
          retryBaseDelayMs: 250,
        },
        image: {
          maxSubmitAttempts: 2,
          submitTimeoutMs: 60_000,
          operationTimeoutMs: 120_000,
          allowResubmitAfterAccepted: false,
        },
      },
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const drivers = new DriverRegistry();

    const receipts = await (await probeService(drivers)).run(
      testConfig(),
      snapshot,
      'smoke',
      { providerId: 'primary', modelId: 'image' },
      new AbortController().signal,
    );

    expect(receipts).toEqual([expect.objectContaining({
      driverId: 'fake-image',
      providerId: 'primary',
      modelId: 'image',
      level: 'smoke',
      success: true,
      artifacts: [{
        artifactId: `artifact:sha256:${'a'.repeat(64)}`,
        mimeType: 'image/png',
        width: 512,
        height: 512,
      }],
    })]);
    expect(receivedRequest).toEqual({
      model: { providerId: 'primary', modelId: 'image' },
      operation: {
        kind: 'generate',
        prompt: 'A cute chibi orange robot mascot head with soft rounded shapes, oversized expressive cyan eyes, and a friendly smile, centered on a soft teal background, polished 3D game icon, square composition, no text, no border, not scary.',
        count: 1,
      },
    });
  });

  it('uses the compiled Anthropic execution path and stops at message_stop without waiting for EOF', async () => {
    let requestCount = 0;
    let receivedUrl: string | undefined;
    let receivedBody: Record<string, unknown> | undefined;
    let connectionClosed: Promise<void> | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      requestCount++;
      receivedUrl = incoming.url;
      receivedBody = await readJsonRequest(incoming);
      connectionClosed = new Promise<void>((resolve) => response.once('close', resolve));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      writeAnthropicEvent(response, {
        type: 'message_start',
        message: {
          id: 'probe-message', type: 'message', role: 'assistant', content: [], model: 'wire-probe-model',
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      writeAnthropicEvent(response, {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      writeAnthropicEvent(response, { type: 'message_stop' });
      // Compatible endpoints may keep the SSE connection alive after protocol completion.
    });
    const definition = model('anthropic-messages', 'anthropic/probe', 'anthropic');
    const candidate = config('anthropic-messages', baseUrl, definition);
    const drivers = new DriverRegistry();
    drivers.register(createAnthropicMessagesDriver());
    const snapshot = compileInferenceConfig(candidate, testCatalog(definition), drivers);

    const receipts = await (await probeService(drivers)).run(
      candidate,
      snapshot,
      'smoke',
      { providerId: 'primary', modelId: 'chat' },
      new AbortController().signal,
    );

    expect(receipts).toEqual([expect.objectContaining({
      driverId: 'anthropic-messages',
      providerId: 'primary',
      modelId: 'chat',
      level: 'smoke',
      success: true,
    })]);
    expect(requestCount).toBe(1);
    expect(receivedUrl).toBe('/v1/messages');
    expect(receivedBody).toMatchObject({
      model: 'wire-probe-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 16,
      stream: true,
      cache_control: { type: 'ephemeral' },
    });
    await expect(Promise.race([
      connectionClosed,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300)),
    ])).resolves.not.toBe('timeout');
  });

  it('applies an absolute smoke deadline even while an endpoint keeps sending pings', async () => {
    const baseUrl = await serve(async (incoming, response) => {
      await readJsonRequest(incoming);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      writeAnthropicEvent(response, {
        type: 'message_start',
        message: {
          id: 'never-finished', type: 'message', role: 'assistant', content: [], model: 'wire-probe-model',
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      const ping = setInterval(() => writeAnthropicEvent(response, { type: 'ping' }), 5);
      response.once('close', () => clearInterval(ping));
    });
    const definition = model('anthropic-messages', 'anthropic/timeout', 'anthropic');
    const candidate = config('anthropic-messages', baseUrl, definition);
    const drivers = new DriverRegistry();
    drivers.register(createAnthropicMessagesDriver());
    const snapshot = compileInferenceConfig(candidate, testCatalog(definition), drivers);

    const receipts = await (await probeService(drivers, 40)).run(
      candidate,
      snapshot,
      'smoke',
      { providerId: 'primary', modelId: 'chat' },
      new AbortController().signal,
    );

    expect(receipts).toEqual([expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        source: 'timeout',
        localCode: 'AI_ABSOLUTE_DEADLINE_TIMEOUT',
      }),
    })]);
  });

  it('uses Responses by default for an OpenAI model smoke probe', async () => {
    let receivedUrl: string | undefined;
    let receivedBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      receivedUrl = incoming.url;
      receivedBody = await readJsonRequest(incoming);
      response.writeHead(422, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: 'expected probe stop' }));
    });
    const definition = model('openai', 'openai/probe-default', 'openai');
    const candidate = config('openai', baseUrl, definition);
    const drivers = new DriverRegistry();
    drivers.register(createOpenAiDriver());
    const snapshot = compileInferenceConfig(candidate, testCatalog(definition), drivers);

    const receipts = await (await probeService(drivers)).run(
      candidate,
      snapshot,
      'smoke',
      { providerId: 'primary', modelId: 'chat' },
      new AbortController().signal,
    );

    expect(receivedUrl).toBe('/responses');
    expect(receivedBody).toMatchObject({
      model: 'wire-probe-model',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      max_output_tokens: 16,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
    });
    expect(receipts).toEqual([expect.objectContaining({ success: false, status: 422 })]);
  });

  it('uses explicitly selected Chat Completions and preserves the upstream smoke error', async () => {
    let requestCount = 0;
    let receivedUrl: string | undefined;
    let receivedBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      requestCount++;
      receivedUrl = incoming.url;
      receivedBody = await readJsonRequest(incoming);
      response.writeHead(422, {
        'content-type': 'application/json',
        'x-request-id': 'probe-request-422',
      });
      response.end(JSON.stringify({ detail: 'probe rejected verbatim', vendor_field: 42 }));
    });
    const definition = model('openai', 'openai/probe', 'openai');
    const candidate = config('openai', baseUrl, definition);
    candidate.providers.primary!.driverOptions = { wireApi: 'chat_completions' };
    candidate.policies.ai.maxAttempts = 6;
    const drivers = new DriverRegistry();
    drivers.register(createOpenAiDriver());
    const snapshot = compileInferenceConfig(candidate, testCatalog(definition), drivers);

    const receipts = await (await probeService(drivers)).run(
      candidate,
      snapshot,
      'smoke',
      { providerId: 'primary', modelId: 'chat' },
      new AbortController().signal,
    );

    expect(requestCount).toBe(1);
    expect(receivedUrl).toBe('/chat/completions');
    expect(receivedBody).toMatchObject({
      model: 'wire-probe-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_completion_tokens: 16,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(receipts).toEqual([expect.objectContaining({
      success: false,
      status: 422,
      requestId: 'probe-request-422',
      error: expect.objectContaining({
        source: 'provider',
        message: 'probe rejected verbatim',
        upstream: expect.objectContaining({
          status: 422,
          message: 'probe rejected verbatim',
          requestId: 'probe-request-422',
          body: { detail: 'probe rejected verbatim', vendor_field: 42 },
        }),
      }),
    })]);
  });
});
