import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TMPDIR ?? '/tmp', getAppPath: () => process.env.TMPDIR ?? '/tmp' },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));

import type { AgentControlState } from '../../../shared/types/agent-control.js';
import type { AgentInputEvent } from '../../../shared/types/index.js';
import type { AiEvent } from '../../inference/ai/contracts.js';
import { DefaultAiGateway } from '../../inference/ai/public-gateway.js';
import { DefaultAgentInferencePort } from '../../inference/application/agent-inference-port.js';
import type { ModelDefinition } from '../../inference/catalog/contracts.js';
import { emptyInferenceConfig } from '../../inference/control/bootstrap-config.js';
import type { ProviderInstance } from '../../inference/control/config-schema.js';
import { createOpenAiDriver } from '../../inference/drivers/openai/driver.js';
import { RuntimeSnapshotStore } from '../../inference/execution/runtime-snapshot.js';
import { MemoryArtifactStore } from '../../inference/image/artifact-store.js';
import { agentIncidentStore } from '../../observability/incidents/agent-incident-store.js';
import { AgentEngine } from '../agent-engine.js';
import { AgentConversationContext } from '../context/agent-conversation-context.js';
import { ContextSettlementConversation, Settler } from '../conversation/settler.js';
import { PendingSettlement } from '../tool-call/pending-settlement.js';

const target = { providerId: 'sample-provider', modelId: 'sample-model' };

function sse(frames: unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function chunk(delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>) {
  return {
    id: 'sample-completion', object: 'chat.completion.chunk', created: 1, model: 'sample-wire-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage && { usage }),
  };
}

function port(fetch: typeof globalThis.fetch, events: AiEvent[]): DefaultAgentInferencePort {
  const definition: ModelDefinition = {
    id: 'sample/chat', displayName: 'Sample model', kind: 'ai', lifecycle: 'active', compatibleDrivers: ['openai'],
    inputModalities: ['text'], outputModalities: ['text'], capabilities: { streaming: true, tools: true },
    limits: { contextWindow: 200_000 }, source: { kind: 'local', version: '1' },
  };
  const provider: ProviderInstance = {
    displayName: 'Sample provider', driver: 'openai', enabled: true,
    connection: { baseUrl: 'https://sample.invalid/v1', auth: { kind: 'none' }, headers: {}, proxyId: null },
    driverOptions: { wireApi: 'chat_completions' },
    models: { 'sample-model': { catalogId: definition.id, upstreamId: 'sample-wire-model', enabled: true, options: {} } },
  };
  const compiled = createOpenAiDriver({ fetch }).compile({
    providerId: target.providerId, modelId: target.modelId, provider, binding: provider.models[target.modelId]!,
    catalogModel: definition,
    catalog: { version: 'test', loadedAt: '2026-01-01T00:00:00.000Z', models: new Map([[definition.id, definition]]) },
    configRevision: 1,
  });
  const snapshots = new RuntimeSnapshotStore();
  snapshots.publish({
    configRevision: 1, catalogVersion: 'test', createdAt: '2026-01-01T00:00:00.000Z',
    targets: new Map([[target.providerId, new Map([[target.modelId, { ...compiled, modelDefinition: definition }]])]]),
    policies: emptyInferenceConfig().policies,
  });
  const gateway = new DefaultAiGateway(snapshots, { sleep: async () => undefined }, () => ({
    attemptStarted: () => undefined,
    event: (event) => { events.push(event); },
    close: () => undefined,
  }));
  return new DefaultAgentInferencePort(gateway, snapshots, new MemoryArtifactStore());
}

class RetryIntegrationEngine extends AgentEngine {
  readonly executeTool = vi.fn(async (raw: { callId: string; modelName: string; rawParams: unknown }) =>
    new PendingSettlement(raw.callId, raw.modelName, { ok: true, text: 'Sample tool result' }));

  constructor(inference: DefaultAgentInferencePort, context: AgentConversationContext) {
    super();
    this.id = 'sample-agent';
    this.mainAgentId = this.id;
    this.currentTarget = target;
    this.currentModel = 'sample-provider::sample-model';
    this.incidentTarget = { agentId: this.id };
    this.inference = inference;
    this.context = context;
    this.toolCatalog = { snapshot: () => ({
      definitions: () => [{ name: 'lookup', description: 'Look up a sample value', input_schema: { type: 'object' } }],
      resolve: () => undefined,
    }) } as never;
    this.toolFace = {} as never;
    this.toolCoordinator = { run: this.executeTool } as never;
    this.settler = new Settler(
      new ContextSettlementConversation(context, () => undefined),
      (callId) => this.recordToolSettled(callId),
    );
  }

  buildSystemPrompt(): string { return 'Sample instructions'; }
  getControlState(): AgentControlState { return {} as AgentControlState; }
  protected applyEvents(_events: AgentInputEvent[]): void {}
  run(): Promise<unknown> { return this.runTurn(new AbortController().signal); }
}

beforeEach(() => vi.clearAllMocks());

describe('Agent inference retries through the OpenAI SDK', () => {
  it('executes only the successful tool call after a partial stream failure and an empty response', async () => {
    const bodies: unknown[] = [];
    const events: AiEvent[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      switch (bodies.length) {
        case 1:
          return sse([
            chunk({ content: 'stale answer', reasoning_content: 'stale thought', tool_calls: [{
              index: 0, id: 'call-stale', type: 'function', function: { name: 'lookup', arguments: '{"id":' },
            }] }, null, { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 20 } }),
            { error: { code: 'upstream_stream_read_error', type: 'upstream_error', message: 'Sample stream interruption' } },
          ]);
        case 2:
          return sse([chunk({}, 'stop', { prompt_tokens: 50, completion_tokens: 0 })]);
        case 3:
          return sse([chunk({ tool_calls: [{
            index: 0, id: 'call-fresh', type: 'function', function: { name: 'lookup', arguments: '{"id":2}' },
          }] }, 'tool_calls', { prompt_tokens: 7, completion_tokens: 3 })]);
        default:
          return sse([chunk({ content: 'Finished.' }, 'stop')]);
      }
    });
    const inference = port(fetch as typeof globalThis.fetch, events);
    const context = new AgentConversationContext({ inference, target });
    context.addUserMessage('Sample task');
    const engine = new RetryIntegrationEngine(inference, context);

    await engine.run();

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(engine.executeTool).toHaveBeenCalledOnce();
    expect(engine.executeTool.mock.calls[0]![0]).toEqual({ callId: 'call-fresh', modelName: 'lookup', rawParams: { id: 2 } });
    expect(events.filter((event) => event.kind === 'response.retrying')).toMatchObject([
      { attempt: 1, error: { source: 'provider', upstream: { code: 'upstream_stream_read_error' } } },
      { attempt: 2, error: { source: 'provider', localCode: 'AI_RESULT_EMPTY', upstream: { stopReason: 'end_turn' } } },
    ]);
    const successful = events.filter((event) => event.kind === 'response.completed');
    expect(successful).toHaveLength(2);
    expect(successful[0]).toMatchObject({ attempt: 3, result: { text: '', reasoning: '', usage: { totalInputTokens: 7, totalOutputTokens: 3 } } });
    expect(successful[0]!.result.usage.cachedInputTokens).toBeUndefined();
    expect(JSON.stringify(context.getAllMessages())).not.toContain('stale');
    expect(JSON.stringify(bodies[3])).not.toContain('stale');
    expect(agentIncidentStore.raise).not.toHaveBeenCalled();
  });

  it('records one final empty-response incident with the actual attempt and provider stop reason', async () => {
    const events: AiEvent[] = [];
    const fetch = vi.fn(async () => sse([chunk({}, 'content_filter')]));
    const inference = port(fetch as typeof globalThis.fetch, events);
    const context = new AgentConversationContext({ inference, target });
    context.addUserMessage('Sample task');
    const engine = new RetryIntegrationEngine(inference, context);

    await expect(engine.run()).rejects.toMatchObject({
      failure: { diagnostics: { attempt: 3, localCode: 'AI_RESULT_EMPTY', upstream: { stopReason: 'content_filter' } } },
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(engine.executeTool).not.toHaveBeenCalled();
    expect(events.map((event) => event.kind)).toEqual(['response.started', 'response.retrying', 'response.retrying', 'response.failed']);
    expect(agentIncidentStore.raise).toHaveBeenCalledOnce();
    expect(agentIncidentStore.raise).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ source: 'provider', stage: 'result', attempt: 3, upstream: expect.objectContaining({ stopReason: 'content_filter' }) }),
    }));
  });
});
