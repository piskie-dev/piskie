import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiAttemptEvent, AiRequest } from '../../../ai/contracts.js';
import type { CatalogSnapshot, ModelDefinition } from '../../../catalog/contracts.js';
import type { ProviderInstance } from '../../../control/config-schema.js';
import type { ArtifactReader } from '../../../execution/artifact-port.js';
import { GatewayCallError } from '../../../execution/call-error.js';
import type { AttemptContext } from '../../../execution/contracts.js';
import { createAnthropicMessagesDriver } from '../driver.js';

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
  if (!address || typeof address === 'string') throw new Error('Fake Anthropic server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

function model(id = 'anthropic/test-chat', family = 'anthropic'): ModelDefinition {
  return {
    id,
    displayName: 'Test Claude',
    kind: 'ai',
    family,
    lifecycle: 'active',
    compatibleDrivers: ['anthropic-messages'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
    reasoning: {
      mode: 'effort',
      options: [
        { kind: 'effort', effort: 'low' },
        { kind: 'effort', effort: 'medium' },
        { kind: 'effort', effort: 'high' },
        { kind: 'effort', effort: 'max' },
      ],
      defaultSelection: { kind: 'effort', effort: 'high' },
      mandatory: true,
      transportPreset: 'anthropic-adaptive-effort',
      replayPolicy: 'visible',
    },
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

function provider(
  baseUrl: string,
  auth: ProviderInstance['connection']['auth'] = {
    kind: 'api_key',
    header: 'X-API-Key',
    value: 'plain-anthropic-key',
  },
): ProviderInstance {
  return {
    displayName: 'Fake Anthropic',
    driver: 'anthropic-messages',
    enabled: true,
    connection: {
      baseUrl,
      auth,
      headers: { 'X-Piskie-Test': 'present' },
      proxyId: null,
    },
    models: {
      chat: {
        catalogId: 'anthropic/test-chat',
        upstreamId: 'wire-claude-model',
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
    messages: [
      { role: 'system', content: [{ kind: 'text', text: 'system prompt' }] },
      {
        role: 'user',
        content: [
          { kind: 'text', text: 'inspect this' },
          { kind: 'input_image', artifact: { artifactId: 'input-image' }, detail: 'high' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            kind: 'reasoning',
            item: {
              protocol: 'anthropic-thinking',
              text: 'prior thought',
              signature: 'prior-signature',
            },
          },
          { kind: 'tool_call', callId: 'prior-call', name: 'lookup', arguments: '{"id":"41"}' },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'prior-call',
        content: [{ kind: 'text', text: 'previous result' }],
      },
    ],
    tools: [{
      name: 'lookup',
      description: 'Look up a value',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }],
    responseFormat: {
      kind: 'json_schema',
      name: 'answer',
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      strict: true,
    },
    generation: {
      maxOutputTokens: 64,
      temperature: 0.5,
      topP: 0.9,
      stop: ['END'],
      reasoning: { kind: 'effort', effort: 'high' },
    },
    extensions: {
      'anthropic-messages': { metadata: { user_id: 'piskie-test' }, service_tier: 'auto' },
    },
  };
}

function cacheHeavyRequest(): AiRequest {
  return {
    model: { providerId: 'provider', modelId: 'chat' },
    messages: [
      {
        role: 'system',
        content: [
          { kind: 'text', text: 'stable system prefix' },
          { kind: 'text', text: 'stable system suffix' },
        ],
      },
      ...Array.from({ length: 21 }, (_, index): AiRequest['messages'][number] => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{ kind: 'text', text: `conversation-${index}` }],
      })),
    ],
    tools: [
      { name: 'first_tool', description: 'First tool', inputSchema: { type: 'object', properties: {} } },
      { name: 'last_tool', description: 'Last tool', inputSchema: { type: 'object', properties: {} } },
    ],
  };
}

function attemptContext(): AttemptContext {
  return {
    runId: 'run-anthropic',
    traceId: 'trace-anthropic',
    signal: new AbortController().signal,
    attempt: 1,
    configRevision: 4,
    connectTimeoutMs: 1_000,
  };
}

function artifactReader(): ArtifactReader {
  return {
    read: async (ref) => {
      expect(ref).toEqual({ artifactId: 'input-image' });
      return { bytes: Uint8Array.from([1, 2, 3]), mimeType: 'image/png' };
    },
  };
}

async function collect(events: AsyncIterable<AiAttemptEvent>): Promise<AiAttemptEvent[]> {
  const result: AiAttemptEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function writeSse(response: http.ServerResponse, event: Record<string, unknown>): Promise<void> {
  const frame = `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
  const widths = [1, 3, 7, 2, 11];
  let offset = 0;
  let split = 0;
  while (offset < frame.length) {
    const next = Math.min(frame.length, offset + widths[split % widths.length]!);
    response.write(frame.slice(offset, next));
    offset = next;
    split++;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function writeCompletedResponse(response: http.ServerResponse): Promise<void> {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  await writeSse(response, {
    type: 'message_start',
    message: {
      id: 'cache-test-message',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'wire-claude-model',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  await writeSse(response, { type: 'message_stop' });
  response.end();
}

function compile(
  baseUrl: string,
  artifacts?: ArtifactReader,
  modelOptions: Record<string, unknown> = {},
  family = 'anthropic',
) {
  const definition = model(`${family}/test-chat`, family);
  const configuredProvider = provider(baseUrl);
  configuredProvider.models.chat.catalogId = definition.id;
  configuredProvider.models.chat.options = modelOptions;
  return createAnthropicMessagesDriver({ artifacts }).compile({
    providerId: 'provider',
    provider: configuredProvider,
    modelId: 'chat',
    binding: configuredProvider.models.chat,
    catalogModel: definition,
    catalog: catalog(definition),
    configRevision: 4,
  });
}

describe('Anthropic Messages SDK driver', () => {
  it('publishes self-contained prompt-cache configuration semantics in the Driver schema', () => {
    const schema = createAnthropicMessagesDriver().manifest.modelOptionsSchema as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };

    expect(schema.properties?.promptCaching).toEqual(expect.objectContaining({
      default: true,
      type: 'boolean',
      description: expect.stringMatching(
        /Defaults to true.*Anthropic Messages protocol.*compatible endpoints.*false.*cache_control.*5-minute ephemeral/s,
      ),
    }));
    expect(schema.properties).not.toHaveProperty('defaultMaxTokens');
    expect(schema.required).toBeUndefined();
  });

  it('ignores unknown persisted options but still rejects invalid known options', () => {
    const definition = model();
    const configuredProvider = provider('http://127.0.0.1:1');
    configuredProvider.driverOptions = { futureProviderOption: true };
    configuredProvider.models.chat.options = { futureModelOption: true };
    const driver = createAnthropicMessagesDriver();

    expect(driver.validateProviderOptions(configuredProvider.driverOptions)).toEqual([]);
    expect(driver.validateModelOptions(configuredProvider.models.chat.options)).toEqual([]);
    expect(() => driver.compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 4,
    })).not.toThrow();
    expect(driver.validateModelOptions({ defaultMaxTokens: 0 })).toEqual([]);
    expect(driver.validateModelOptions({ promptCaching: 'yes' })).toEqual([
      expect.objectContaining({ code: 'ANTHROPIC_OPTIONS_INVALID', path: '/promptCaching' }),
    ]);
  });

  it('resolves the configured proxy transport while compiling the exact target', () => {
    const definition = model();
    const configuredProvider = provider('http://127.0.0.1:1');
    configuredProvider.connection.proxyId = 'proxy-anthropic';
    const resolveFetch = vi.fn((_proxyId: string | null, fallback: typeof globalThis.fetch) => fallback);

    createAnthropicMessagesDriver({ resolveFetch }).compile({
      providerId: 'provider',
      provider: configuredProvider,
      modelId: 'chat',
      binding: configuredProvider.models.chat,
      catalogModel: definition,
      catalog: catalog(definition),
      configRevision: 4,
    });

    expect(resolveFetch).toHaveBeenCalledOnce();
    expect(resolveFetch).toHaveBeenCalledWith('proxy-anthropic', globalThis.fetch);
  });

  it('maps the canonical request and projects arbitrarily split SDK stream events', async () => {
    let requestCount = 0;
    let receivedBody: Record<string, unknown> | undefined;
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    let receivedUrl: string | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      requestCount++;
      receivedUrl = incoming.url;
      receivedHeaders = incoming.headers;
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;

      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events: Array<Record<string, unknown>> = [
        {
          type: 'message_start',
          message: {
            id: 'msg-1', type: 'message', role: 'assistant', content: [], model: 'wire-claude-model',
            stop_reason: null, stop_sequence: null,
            usage: {
              input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 2,
              cache_creation_input_tokens: 3, output_tokens_details: { thinking_tokens: 1 },
            },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fresh thought' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fresh-' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"answer":"ok"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"id"' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"42"}' } },
        { type: 'content_block_stop', index: 2 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: {
            input_tokens: null, output_tokens: 9, cache_read_input_tokens: null,
            cache_creation_input_tokens: null, output_tokens_details: { thinking_tokens: 4 },
          },
        },
        { type: 'message_stop' },
      ];
      for (const event of events) await writeSse(response, event);
      response.end();
    });
    const target = compile(baseUrl, artifactReader());

    const events = await collect(target.ai!.openAttempt(request(), attemptContext()));

    expect(requestCount).toBe(1);
    expect(receivedUrl).toBe('/v1/messages');
    expect(receivedHeaders).toMatchObject({
      'x-api-key': 'plain-anthropic-key',
      'x-piskie-test': 'present',
    });
    expect(receivedBody).toMatchObject({
      model: 'wire-claude-model',
      max_tokens: 64,
      stream: true,
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
      tools: [{
        name: 'lookup',
        description: 'Look up a value',
        input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        cache_control: { type: 'ephemeral' },
      }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: request().responseFormat!.kind === 'json_schema'
          ? request().responseFormat!.schema
          : {} },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'prior thought', signature: 'prior-signature' },
            { type: 'tool_use', id: 'prior-call', name: 'lookup', input: { id: '41' } },
          ],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result', tool_use_id: 'prior-call', content: [{ type: 'text', text: 'previous result' }],
          }],
        },
      ],
    });
    expect(events).toEqual([
      {
        kind: 'usage.updated',
        // Anthropic 的 input_tokens 不含缓存两项，归一化后 totalInputTokens = 11 + 2 + 3
        // 直接使用 input_tokens 会漏掉缓存两项，导致长会话用量严重低报。
        usage: { totalInputTokens: 16, totalOutputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 3, reasoningTokens: 1 },
      },
      { kind: 'reasoning.delta', text: 'fresh thought' },
      {
        kind: 'reasoning.item',
        item: {
          protocol: 'anthropic-thinking',
          text: 'fresh thought',
          signature: 'fresh-signature',
        },
      },
      { kind: 'text.delta', text: '{"answer":"ok"}' },
      { kind: 'tool.started', callId: 'call-1', name: 'lookup' },
      { kind: 'tool.arguments.delta', callId: 'call-1', delta: '{"id"' },
      { kind: 'tool.arguments.delta', callId: 'call-1', delta: ':"42"}' },
      { kind: 'tool.completed', callId: 'call-1' },
      { kind: 'usage.updated', usage: { totalOutputTokens: 9, reasoningTokens: 4 } },
      { kind: 'response.completed', stopReason: 'tool_use' },
    ]);
  });

  it('writes all four cache layers to the Anthropic wire request for long agent conversations', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      await writeCompletedResponse(response);
    });
    const target = compile(baseUrl);

    await collect(target.ai!.openAttempt(cacheHeavyRequest(), attemptContext()));

    expect(receivedBody?.cache_control).toEqual({ type: 'ephemeral' });
    expect(receivedBody?.system).toEqual([
      { type: 'text', text: 'stable system prefix' },
      { type: 'text', text: 'stable system suffix', cache_control: { type: 'ephemeral' } },
    ]);
    expect(receivedBody?.tools).toEqual([
      { name: 'first_tool', description: 'First tool', input_schema: { type: 'object', properties: {} } },
      {
        name: 'last_tool',
        description: 'Last tool',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
      },
    ]);
    const messages = receivedBody?.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'conversation-1', cache_control: { type: 'ephemeral' } }],
    });
    expect(JSON.stringify(receivedBody).match(/"cache_control"/g)).toHaveLength(4);
  });

  it('sends no cache controls when caching is explicitly disabled for a model', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      await writeCompletedResponse(response);
    });
    const target = compile(baseUrl, undefined, { promptCaching: false });

    await collect(target.ai!.openAttempt(cacheHeavyRequest(), attemptContext()));

    expect(JSON.stringify(receivedBody)).not.toContain('cache_control');
  });

  it('defaults prompt caching on for Anthropic-compatible providers', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      await writeCompletedResponse(response);
    });
    const target = compile(baseUrl, undefined, {}, 'deepseek');

    await collect(target.ai!.openAttempt(cacheHeavyRequest(), attemptContext()));

    expect(receivedBody?.cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(receivedBody).match(/"cache_control"/g)).toHaveLength(4);
  });

  it('allows a compatible provider to opt into the verified Anthropic cache protocol', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      await writeCompletedResponse(response);
    });
    const target = compile(baseUrl, undefined, { promptCaching: true }, 'deepseek');

    await collect(target.ai!.openAttempt(cacheHeavyRequest(), attemptContext()));

    expect(receivedBody?.cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(receivedBody).match(/"cache_control"/g)).toHaveLength(4);
  });

  it('preserves Anthropic error fields and performs no SDK retry', async () => {
    let requestCount = 0;
    const baseUrl = await serve((_incoming, response) => {
      requestCount++;
      response.writeHead(529, {
        'content-type': 'application/json',
        'request-id': 'request-real-529',
      });
      response.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', code: 'capacity_busy', message: 'custom overloaded body' },
        request_id: 'request-body-529',
      }));
    });
    const target = compile(baseUrl);
    const simpleRequest: AiRequest = {
      model: { providerId: 'provider', modelId: 'chat' },
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
    };

    let failure: unknown;
    try {
      await collect(target.ai!.openAttempt(simpleRequest, attemptContext()));
    } catch (error) {
      failure = error;
    }

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(GatewayCallError);
    expect(failure).toMatchObject({
      source: 'provider',
      message: 'custom overloaded body',
      upstream: {
        status: 529,
        code: 'capacity_busy',
        type: 'overloaded_error',
        message: 'custom overloaded body',
        requestId: 'request-real-529',
        body: {
          type: 'error',
          error: { type: 'overloaded_error', code: 'capacity_busy', message: 'custom overloaded body' },
          request_id: 'request-body-529',
        },
      },
    });
  });

  it('keeps concurrent attempt error observations isolated', async () => {
    async function failingTarget(status: number, message: string, requestId: string) {
      const baseUrl = await serve(async (_incoming, response) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        response.writeHead(status, { 'content-type': 'application/json', 'request-id': requestId });
        response.end(JSON.stringify({ error: { type: `error_${status}`, message } }));
      });
      return compile(baseUrl);
    }
    const [left, right] = await Promise.all([
      failingTarget(429, 'left limit', 'left-request'),
      failingTarget(503, 'right unavailable', 'right-request'),
    ]);
    const simpleRequest: AiRequest = {
      model: { providerId: 'provider', modelId: 'chat' },
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
    };

    const settled = await Promise.allSettled([
      collect(left.ai!.openAttempt(simpleRequest, attemptContext())),
      collect(right.ai!.openAttempt(simpleRequest, attemptContext())),
    ]);

    expect(settled[0]).toMatchObject({
      status: 'rejected',
      reason: { upstream: { status: 429, message: 'left limit', requestId: 'left-request' } },
    });
    expect(settled[1]).toMatchObject({
      status: 'rejected',
      reason: { upstream: { status: 503, message: 'right unavailable', requestId: 'right-request' } },
    });
  });
});
