import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test', getAppPath: () => '/tmp/piskie-test' },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: {
    raise: vi.fn(),
    recover: vi.fn(),
  },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: {
    archiveOriginalMessages: vi.fn(async () => '/tmp/original-messages.json'),
  },
}));

import { AgentEngine } from '../agent-engine.js';
import { AgentConversationContext } from '../context/agent-conversation-context.js';
import { COMPACTION_INSTRUCTION } from '../context/compaction-engine.js';
import { DefaultAiGateway } from '../../inference/ai/public-gateway.js';
import type { ModelDefinition, CatalogSnapshot } from '../../inference/catalog/contracts.js';
import type { ProviderInstance } from '../../inference/control/config-schema.js';
import { createOpenAiDriver } from '../../inference/drivers/openai/driver.js';
import { RuntimeSnapshotStore, type CompiledTarget } from '../../inference/execution/runtime-snapshot.js';
import { MemoryArtifactStore } from '../../inference/image/artifact-store.js';
import { DefaultAgentInferencePort } from '../../inference/application/agent-inference-port.js';
import type { AgentControlState } from '../../../shared/types/agent-control.js';
import type { AIResponse, AgentInputEvent, Message, Tool } from '../../../shared/types/index.js';

const servers: http.Server[] = [];
const TARGET = { providerId: 'provider', modelId: 'chat' };
const SYSTEM_PROMPT = 'ORIGINAL SYSTEM PROMPT';
const ASSIGNMENT = '<assignment>完成目标一、目标二、目标三；前两项完成后继续第三项。</assignment>';
const PENDING_USER = 'PENDING USER INPUT';
const FIRST_RESPONSE = 'FIRST RESPONSE';
const FINAL_RESPONSE = 'FINAL RESPONSE';
const SUMMARY = '# Compact summary\n\n目标一和目标二已完成；CURRENT TASK 是完成目标三。';
const TOOLS: Tool[] = [{
  name: 'lookup',
  description: 'Look up a value',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
}];
const REASONING_PROFILE = {
  mode: 'effort' as const,
  options: [
    { kind: 'disabled' as const },
    { kind: 'effort' as const, effort: 'low' as const },
    { kind: 'effort' as const, effort: 'high' as const },
  ],
  defaultSelection: { kind: 'effort' as const, effort: 'low' as const },
  mandatory: false,
  transportPreset: 'openai-effort' as const,
  replayPolicy: 'opaque-required' as const,
};

afterEach(async () => {
  const active = servers.splice(0);
  for (const server of active) server.closeAllConnections?.();
  await Promise.all(active.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake OpenAI server did not bind');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function readJson(incoming: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendText(response: http.ServerResponse, text: string, inputTokens: number): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({
    type: 'response.output_text.delta',
    item_id: 'message',
    output_index: 0,
    content_index: 0,
    sequence_number: 1,
    delta: text,
    logprobs: [],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    type: 'response.completed',
    sequence_number: 2,
    response: {
      output: [],
      incomplete_details: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 100,
        total_tokens: inputTokens + 100,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 20 },
      },
    },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function sendOverflow(response: http.ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({
    type: 'error',
    sequence_number: 1,
    code: 'context_length_exceeded',
    message: 'Your input exceeds the context window of this model.\nPlease adjust your input and try again.',
    param: 'input',
  })}\n\n`);
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
    capabilities: { streaming: true, tools: true, reasoning: true },
    reasoning: REASONING_PROFILE,
    limits: { contextWindow: 105_000, maxOutputTokens: 8_000 },
    source: { kind: 'local', version: '1' },
  };
}

function provider(baseUrl: string): ProviderInstance {
  return {
    displayName: 'Fake OpenAI',
    driver: 'openai',
    enabled: true,
    connection: {
      baseUrl,
      auth: { kind: 'bearer', value: 'test-key' },
      headers: {},
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

function inference(baseUrl: string): DefaultAgentInferencePort {
  const definition = model();
  const configuredProvider = provider(baseUrl);
  const catalog: CatalogSnapshot = {
    version: 'test',
    loadedAt: '2026-08-14T00:00:00.000Z',
    models: new Map([[definition.id, definition]]),
  };
  const driverTarget = createOpenAiDriver().compile({
    providerId: TARGET.providerId,
    provider: configuredProvider,
    modelId: TARGET.modelId,
    binding: configuredProvider.models.chat,
    catalogModel: definition,
    catalog,
    configRevision: 1,
  });
  const compiled: CompiledTarget = {
    ...driverTarget,
    modelDefinition: definition,
    reasoning: {
      profile: REASONING_PROFILE,
      modelDefault: REASONING_PROFILE.defaultSelection,
    },
  };
  const snapshots = new RuntimeSnapshotStore();
  snapshots.publish({
    configRevision: 1,
    catalogVersion: catalog.version,
    catalogModels: catalog.models,
    targets: new Map([[TARGET.providerId, new Map([[TARGET.modelId, compiled]])]]),
    policies: {
      ai: {
        maxAttempts: 5,
        connectTimeoutMs: 1_000,
        streamIdleTimeoutMs: 1_000,
        retryBaseDelayMs: 3_000,
      },
      image: {
        maxSubmitAttempts: 1,
        submitTimeoutMs: 1_000,
        operationTimeoutMs: 1_000,
        allowResubmitAfterAccepted: false,
      },
    },
    createdAt: '2026-08-14T00:00:00.000Z',
  });
  const gateway = new DefaultAiGateway(snapshots, { sleep: async () => undefined });
  return new DefaultAgentInferencePort(gateway, snapshots, new MemoryArtifactStore());
}

class OverflowIntegrationEngine extends AgentEngine {
  readonly requestPhases: string[] = [];

  constructor(port: DefaultAgentInferencePort, context: AgentConversationContext) {
    super();
    this.id = 'overflow-integration';
    this.mainAgentId = this.id;
    this.currentModel = 'provider::chat';
    this.currentTarget = TARGET;
    this.reasoningOverride = { kind: 'effort', effort: 'high' };
    this.incidentTarget = { agentId: this.id };
    this.inference = port;
    this.context = context;
  }

  buildSystemPrompt(): string { return SYSTEM_PROMPT; }
  getControlState(): AgentControlState { return {} as AgentControlState; }
  protected applyEvents(_events: AgentInputEvent[]): void {}

  override emitStateChange(): void {
    if (this.aiRequestState) this.requestPhases.push(this.aiRequestState.phase);
    super.emitStateChange();
  }

  run(messages: Message[]): Promise<AIResponse> {
    return this.callAI(SYSTEM_PROMPT, TOOLS, messages);
  }
}

describe('OpenAI Responses context overflow recovery', () => {
  it('runs H, H+P overflow, summary generation, and Summary+P resend as four real requests', async () => {
    const bodies: Record<string, unknown>[] = [];
    const baseUrl = await serve(async (incoming, response) => {
      expect(incoming.url).toBe('/v1/responses');
      bodies.push(await readJson(incoming));
      switch (bodies.length) {
        case 1:
          sendText(response, FIRST_RESPONSE, 80_000);
          break;
        case 2:
          sendOverflow(response);
          break;
        case 3:
          sendText(response, SUMMARY, 20_000);
          break;
        case 4:
          sendText(response, FINAL_RESPONSE, 10_000);
          break;
        default:
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'unexpected request' } }));
      }
    });
    const port = inference(baseUrl);
    const context = new AgentConversationContext({
      inference: port,
      target: TARGET,
      mainAgentId: 'overflow-integration',
    });
    const engine = new OverflowIntegrationEngine(port, context);
    const requestShape = {
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      model: TARGET,
      reasoningOverride: engine.reasoningOverride,
      promptCacheKey: 'overflow-integration',
    };

    context.addUserMessage(ASSIGNMENT, 'assignment');
    const firstMessages = await context.getMessagesForAI(requestShape);
    const first = await engine.run(firstMessages.messages);
    expect(first.content).toEqual([{ type: 'text', text: FIRST_RESPONSE }]);
    context.addAssistantMessage(first.content, first.requestInfo.requestId);
    context.addUserMessage(PENDING_USER);

    const overflowMessages = await context.getMessagesForAI(requestShape);
    const recovered = await engine.run(overflowMessages.messages);

    expect(recovered.content).toEqual([{ type: 'text', text: FINAL_RESPONSE }]);
    expect(bodies).toHaveLength(4);
    expect(bodies.map((body) => body.prompt_cache_key)).toEqual([
      'overflow-integration',
      'overflow-integration',
      'overflow-integration',
      'overflow-integration',
    ]);

    const [request1, request2, request3, request4] = bodies as Array<{
      model: string;
      prompt_cache_key: string;
      input: unknown[];
      tools: unknown[];
      reasoning: unknown;
    }>;
    expect(JSON.stringify(request1.input)).toContain(ASSIGNMENT);
    expect(JSON.stringify(request2.input)).toContain(ASSIGNMENT);
    expect(JSON.stringify(request2.input)).toContain(FIRST_RESPONSE);
    expect(JSON.stringify(request2.input)).toContain(PENDING_USER);

    expect(request3.model).toBe(request1.model);
    expect(request3.tools).toEqual(request1.tools);
    expect(request3.reasoning).toEqual(request1.reasoning);
    expect(request3.input.slice(0, -1)).toEqual(request1.input);
    expect(request3.input.at(-1)).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: COMPACTION_INSTRUCTION }],
    });
    expect(JSON.stringify(request3.input)).not.toContain(FIRST_RESPONSE);
    expect(JSON.stringify(request3.input)).not.toContain(PENDING_USER);

    expect(request4.input).toEqual([
      request1.input[0],
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: SUMMARY }],
      },
      { type: 'message', role: 'assistant', content: FIRST_RESPONSE },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: PENDING_USER }],
      },
    ]);
    const resend = JSON.stringify(request4.input);
    expect(resend).not.toContain(ASSIGNMENT);
    expect(resend).not.toContain(COMPACTION_INSTRUCTION);
    expect(engine.requestPhases).toContain('compacting');
    expect(engine.requestPhases).toContain('resending');
    expect(engine.requestPhases.at(-1)).toBe('finished');
  });
});
