import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiAttemptEvent, AiRequest } from '../../../ai/contracts.js';
import type { CatalogSnapshot, ModelDefinition } from '../../../catalog/contracts.js';
import type { ProviderInstance } from '../../../control/config-schema.js';
import { AIErrorType } from '../../../../../shared/constants/index.js';
import { classifyGatewayCallError, GatewayCallError } from '../../../execution/call-error.js';
import type { AttemptContext } from '../../../execution/contracts.js';
import { createOpenAiDriver } from '../driver.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake OpenAI server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}/v1`;
}

function model(): ModelDefinition {
  return {
    id: 'openai/test-chat',
    displayName: 'Test Chat',
    kind: 'ai',
    lifecycle: 'active',
    compatibleDrivers: ['openai'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    capabilities: { streaming: true, tools: true },
    limits: {},
    source: { kind: 'local', version: '1' },
  };
}

function catalog(definition: ModelDefinition = model()): CatalogSnapshot {
  return {
    version: 'test',
    loadedAt: '2026-07-29T00:00:00.000Z',
    models: new Map([[definition.id, definition]]),
  };
}

function provider(baseUrl: string, auth: ProviderInstance['connection']['auth'] = { kind: 'bearer', value: 'plain-key' }): ProviderInstance {
  return {
    displayName: 'Fake OpenAI',
    driver: 'openai',
    enabled: true,
    connection: {
      baseUrl,
      auth,
      headers: { 'X-Piskie-Test': 'present' },
      proxyId: null,
    },
    models: {
      chat: {
        catalogId: 'openai/test-chat',
        upstreamId: 'wire-model',
        enabled: true,
        options: {},
      },
    },
    driverOptions: {},
  };
}

function request(): AiRequest {
  return {
    model: { providerId: 'provider', modelId: 'chat' },
    promptCacheKey: 'agent-cache-key',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
    tools: [{
      name: 'lookup',
      description: 'Look up a value',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }],
    generation: { maxOutputTokens: 32 },
  };
}

function attemptContext(): AttemptContext {
  return {
    runId: 'run-openai',
    traceId: 'trace-openai',
    signal: new AbortController().signal,
    attempt: 1,
    configRevision: 3,
    connectTimeoutMs: 1_000,
  };
}

async function collect(events: AsyncIterable<AiAttemptEvent>): Promise<AiAttemptEvent[]> {
  const result: AiAttemptEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('OpenAI SDK driver', () => {
  it('ignores unknown persisted options but still rejects invalid known options', () => {
    const definition = model();
    const configuredProvider = provider('http://127.0.0.1:1/v1');
    configuredProvider.driverOptions = { futureProviderOption: true };
    configuredProvider.models.chat.options = { reasoningField: 'none', futureModelOption: true };
    const driver = createOpenAiDriver();

    expect(driver.manifest.providerConfigSchema).toMatchObject({
      properties: {
        wireApi: { default: 'responses' },
      },
    });
    expect((driver.manifest.modelOptionsSchema as { properties: Record<string, unknown> }).properties)
      .not.toHaveProperty('wireApi');
    expect(driver.validateProviderOptions(configuredProvider.driverOptions)).toEqual([]);
    expect(driver.validateProviderOptions({ wireApi: 'future-wire-api' })).toEqual([
      expect.objectContaining({ code: 'OPENAI_OPTIONS_INVALID', path: '/wireApi' }),
    ]);
    expect(driver.validateModelOptions(configuredProvider.models.chat.options)).toEqual([]);
    expect(() => driver.compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    })).not.toThrow();
    expect(driver.validateModelOptions({ maxTokensField: 'future-token-field' })).toEqual([
      expect.objectContaining({ code: 'OPENAI_OPTIONS_INVALID', path: '/maxTokensField' }),
    ]);
  });

  it('resolves the configured proxy transport while compiling the exact target', () => {
    const definition = model();
    const configuredProvider = provider('http://127.0.0.1:1/v1');
    configuredProvider.connection.proxyId = 'proxy-openai';
    const resolveFetch = vi.fn((_proxyId: string | null, fallback: typeof globalThis.fetch) => fallback);

    createOpenAiDriver({ resolveFetch }).compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    });

    expect(resolveFetch).toHaveBeenCalledOnce();
    expect(resolveFetch).toHaveBeenCalledWith('proxy-openai', globalThis.fetch);
  });

  it('does not silently compile a proxied target when transport resolution fails', () => {
    const definition = model();
    const configuredProvider = provider('http://127.0.0.1:1/v1');
    configuredProvider.connection.proxyId = 'missing-proxy';

    expect(() => createOpenAiDriver({
      resolveFetch: () => { throw new Error('Inference proxy is missing or disabled: missing-proxy'); },
    }).compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    })).toThrow('Inference proxy is missing or disabled: missing-proxy');
  });

  it('uses Chat Completions when the Provider explicitly selects it', async () => {
    let requestCount = 0;
    let receivedBody: Record<string, unknown> | undefined;
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      requestCount++;
      receivedHeaders = incoming.headers;
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'wire-model', choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }] },
        { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'wire-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id"' } }] }, finish_reason: null }] },
        { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'wire-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"42"}' } }] }, finish_reason: 'tool_calls' }] },
        {
          id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'wire-model', choices: [],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 3,
            total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
          },
        },
      ];
      for (const event of events) {
        const frame = `data: ${JSON.stringify(event)}\n\n`;
        const split = Math.floor(frame.length / 2);
        response.write(frame.slice(0, split));
        await new Promise<void>((resolve) => setImmediate(resolve));
        response.write(frame.slice(split));
      }
      response.end('data: [DONE]\n\n');
    });
    const configuredProvider = provider(baseUrl);
    configuredProvider.driverOptions = { wireApi: 'chat_completions' };
    const definition = model();
    const driver = createOpenAiDriver();
    const target = driver.compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    });

    const events = await collect(target.ai!.openAttempt(request(), attemptContext()));

    expect(requestCount).toBe(1);
    expect(receivedHeaders).toMatchObject({
      authorization: 'Bearer plain-key',
      'x-piskie-test': 'present',
    });
    expect(receivedBody).toMatchObject({
      model: 'wire-model',
      prompt_cache_key: 'agent-cache-key',
      stream: true,
      max_completion_tokens: 32,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    expect(events).toEqual([
      { kind: 'text.delta', text: 'hello ' },
      { kind: 'tool.started', callId: 'call-1', name: 'lookup' },
      { kind: 'tool.arguments.delta', callId: 'call-1', delta: '{"id"' },
      { kind: 'tool.arguments.delta', callId: 'call-1', delta: ':"42"}' },
      {
        kind: 'usage.updated',
        usage: {
          totalInputTokens: 4,
          totalOutputTokens: 3,
          cachedInputTokens: 2,
          cacheWriteTokens: 1,
        },
      },
      { kind: 'tool.completed', callId: 'call-1' },
      { kind: 'response.completed', stopReason: 'tool_use' },
    ]);
  });

  it('uses the Responses endpoint by default when wireApi is omitted', async () => {
    let receivedUrl: string | undefined;
    let receivedBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      receivedUrl = incoming.url;
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;

      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const reasoning = {
        type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted', status: 'completed',
      };
      const events = [
        { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: reasoning },
        {
          type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1,
          content_index: 0, sequence_number: 2, delta: 'hello', logprobs: [],
        },
        {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            output: [reasoning],
            incomplete_details: null,
            usage: {
              input_tokens: 4,
              output_tokens: 3,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        },
      ];
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    const configuredProvider = provider(baseUrl);
    const definition = model();
    const target = createOpenAiDriver().compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    });

    const events = await collect(target.ai!.openAttempt(request(), attemptContext()));

    expect(receivedUrl).toBe('/v1/responses');
    expect(receivedBody).toMatchObject({
      model: 'wire-model',
      prompt_cache_key: 'agent-cache-key',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 32,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
    expect(events).toEqual([
      {
        kind: 'reasoning.item',
        item: {
          protocol: 'openai-responses',
          id: 'rs_1',
          summary: [],
          encryptedContent: 'encrypted',
          status: 'completed',
        },
      },
      { kind: 'text.delta', text: 'hello' },
      {
        kind: 'usage.updated',
        usage: {
          totalInputTokens: 4,
          totalOutputTokens: 3,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 2,
        },
      },
      { kind: 'response.completed', stopReason: 'end_turn' },
    ]);
  });

  it('preserves the original non-standard error body and performs no SDK retry', async () => {
    let requestCount = 0;
    const baseUrl = await serve((_incoming, response) => {
      requestCount++;
      response.writeHead(418, {
        'content-type': 'application/json',
        'x-request-id': 'request-real-418',
      });
      response.end(JSON.stringify({ detail: 'custom upstream body' }));
    });
    const configuredProvider = provider(baseUrl, { kind: 'api_key', header: 'X-API-Key', value: 'plain-custom-key' });
    const definition = model();
    const target = createOpenAiDriver().compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    });

    let failure: unknown;
    try {
      await collect(target.ai!.openAttempt(request(), attemptContext()));
    } catch (error) {
      failure = error;
    }

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(GatewayCallError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: 'custom upstream body',
      upstream: {
        status: 418,
        message: 'custom upstream body',
        requestId: 'request-real-418',
        body: { detail: 'custom upstream body' },
      },
    });
  });

  it('preserves a non-2xx SDK context error even when its HTTP status is retryable', async () => {
    let requestCount = 0;
    const providerError = {
      code: 'context_length_exceeded',
      type: 'invalid_request_error',
      param: 'input',
      message: 'Configured context window was exceeded.',
    };
    const baseUrl = await serve((_incoming, response) => {
      requestCount++;
      response.writeHead(429, {
        'content-type': 'application/json',
        'x-request-id': 'request-http-overflow',
      });
      response.end(JSON.stringify({ error: providerError }));
    });
    const configuredProvider = provider(baseUrl);
    const definition = model();
    const target = createOpenAiDriver().compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    });

    const failure = await collect(target.ai!.openAttempt(request(), attemptContext()))
      .catch((error: unknown) => error);

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(GatewayCallError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: providerError.message,
      upstream: {
        status: 429,
        code: providerError.code,
        type: providerError.type,
        param: providerError.param,
        message: providerError.message,
        requestId: 'request-http-overflow',
        body: { error: providerError },
      },
    });
    expect(classifyGatewayCallError(failure as GatewayCallError)).toBe(AIErrorType.CONTEXT_OVERFLOW);
  });

  it('classifies a Responses SSE error as provider failure without an HTTP status', async () => {
    let requestCount = 0;
    const event = {
      type: 'error',
      sequence_number: 1,
      code: 'context_length_exceeded',
      message: 'Your input exceeds the context window of this model.',
      param: 'input',
    };
    const baseUrl = await serve((_incoming, response) => {
      requestCount++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(event)}\n\n`);
    });
    const configuredProvider = provider(baseUrl);
    const definition = model();
    const target = createOpenAiDriver().compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    });

    const failure = await collect(target.ai!.openAttempt(request(), attemptContext()))
      .catch((error: unknown) => error);

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(GatewayCallError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: event.message,
      upstream: {
        code: event.code,
        type: event.type,
        param: event.param,
        message: event.message,
        body: event,
      },
    });
    expect((failure as GatewayCallError).upstream?.status).toBeUndefined();
  });

  it('preserves a Chat Completions top-level SSE APIError as context overflow without an HTTP status', async () => {
    let requestCount = 0;
    const providerError = {
      code: 'context_length_exceeded',
      type: 'invalid_request_error',
      param: 'messages',
      message: 'Your input exceeds the context window of this model.',
    };
    const baseUrl = await serve((incoming, response) => {
      requestCount++;
      expect(incoming.url).toBe('/v1/chat/completions');
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-request-id': 'request-stream-overflow',
      });
      // OpenAI SDK's shared SSE parser throws APIError for this envelope before
      // the Chat Completions event projector can observe an event.
      response.end(`data: ${JSON.stringify({ error: providerError })}\n\n`);
    });
    const configuredProvider = provider(baseUrl);
    configuredProvider.driverOptions = { wireApi: 'chat_completions' };
    const definition = model();
    const target = createOpenAiDriver().compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    });

    const failure = await collect(target.ai!.openAttempt(request(), attemptContext()))
      .catch((error: unknown) => error);

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(GatewayCallError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: providerError.message,
      upstream: {
        code: providerError.code,
        type: providerError.type,
        param: providerError.param,
        message: providerError.message,
        requestId: 'request-stream-overflow',
        body: providerError,
      },
    });
    expect((failure as GatewayCallError).upstream?.status).toBeUndefined();
    expect(classifyGatewayCallError(failure as GatewayCallError)).toBe(AIErrorType.CONTEXT_OVERFLOW);
  });

  it('keeps an actual SDK connection failure classified as transport', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('socket unavailable');
    }) as unknown as typeof globalThis.fetch;
    const configuredProvider = provider('http://127.0.0.1:1/v1');
    configuredProvider.driverOptions = { wireApi: 'chat_completions' };
    const definition = model();
    const target = createOpenAiDriver({ fetch }).compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 3,
    });

    const failure = await collect(target.ai!.openAttempt(request(), attemptContext()))
      .catch((error: unknown) => error);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(GatewayCallError);
    expect(failure).toMatchObject({ source: 'transport' });
    expect((failure as GatewayCallError).upstream).toBeUndefined();
    expect(classifyGatewayCallError(failure as GatewayCallError)).toBe(AIErrorType.NETWORK);
  });
});
