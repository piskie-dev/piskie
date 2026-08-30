import { describe, expect, it, vi } from 'vitest';
import { AIErrorType } from '../../../../shared/constants/index.js';
import type { AiEvent, AiGateway, AiRequest as DomainAiRequest } from '../../ai/contracts.js';
import { GatewayCallError } from '../../execution/call-error.js';
import type { InferenceRuntimeSnapshot } from '../../execution/runtime-snapshot.js';
import { RuntimeSnapshotStore } from '../../execution/runtime-snapshot.js';
import { MemoryArtifactStore } from '../../image/artifact-store.js';
import {
  DefaultAgentInferencePort,
  type AgentInferenceOptions,
  type AgentInferenceRequest,
  type VisibleDelta,
} from '../agent-inference-port.js';

let requestSequence = 0;
function options(overrides: Partial<AgentInferenceOptions> = {}): AgentInferenceOptions {
  const index = ++requestSequence;
  return {
    requestId: `request-${index}`,
    logicalStartedAt: Date.now(),
    ...overrides,
  };
}

const reasoningProfile = {
  mode: 'effort' as const,
  options: [
    { kind: 'disabled' as const },
    { kind: 'effort' as const, effort: 'low' as const },
    { kind: 'effort' as const, effort: 'medium' as const },
    { kind: 'effort' as const, effort: 'high' as const },
  ],
  defaultSelection: { kind: 'effort' as const, effort: 'medium' as const },
  mandatory: false,
  transportPreset: 'openai-effort' as const,
  replayPolicy: 'opaque-required' as const,
};

function snapshot(): InferenceRuntimeSnapshot {
  return {
    configRevision: 5,
    catalogVersion: 'test',
    catalogModels: new Map([['catalog/chat', {
      id: 'catalog/chat',
      displayName: 'Chat',
      kind: 'ai',
      lifecycle: 'active',
      compatibleDrivers: ['openai'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      capabilities: { streaming: true, tools: true, vision: true },
      reasoning: reasoningProfile,
      limits: { contextWindow: 200_000 },
      source: { kind: 'local', version: '1' },
    }]]),
    targets: new Map([['provider', new Map([['model/one', {
      ref: { providerId: 'provider', modelId: 'model/one' },
      driverId: 'openai',
      upstreamModel: 'wire-model',
      catalogId: 'catalog/chat',
      configRevision: 5,
      ai: { openAttempt: async function* () {} },
      reasoning: {
        profile: reasoningProfile,
        modelDefault: { kind: 'effort', effort: 'low' },
      },
    }]])]]),
    policies: {
      ai: {
        maxAttempts: 3,
        connectTimeoutMs: 1_000,
        streamIdleTimeoutMs: 1_000,
        retryBaseDelayMs: 1,
      },
      image: {
        maxSubmitAttempts: 1,
        submitTimeoutMs: 1_000,
        operationTimeoutMs: 1_000,
        allowResubmitAfterAccepted: false,
      },
    },
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function agentRequest(): AgentInferenceRequest {
  return {
    model: { providerId: 'provider', modelId: 'model/one' },
    promptCacheKey: 'agent-cache-key',
    systemPrompt: 'system rules',
    maxTokens: 100,
    reasoningOverride: { kind: 'effort', effort: 'high' },
    tools: [{
      name: 'lookup',
      description: 'Look up a record',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('input').toString('base64') } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'prior thought', signature: 'signed' },
          { type: 'redacted_thinking', data: 'prior-redacted' },
          { type: 'tool_use', id: 'call-old', name: 'lookup', input: { id: '42' } },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-old',
          is_error: false,
          content: [
            { type: 'text', text: 'found' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('result').toString('base64') } },
          ],
        }],
      },
    ],
  };
}

describe('DefaultAgentInferencePort', () => {
  it('maps Agent messages into inference domain messages and projects one domain result', async () => {
    let mapped: DomainAiRequest | undefined;
    const gateway: AiGateway = {
      open: (request, context) => {
        mapped = request;
        const events = (async function* (): AsyncIterable<AiEvent> {
          const base = { runId: context.runId, emittedAt: 1 };
          yield { ...base, kind: 'response.started', sequence: 1, attempt: 1, model: request.model, configRevision: 5 };
          yield { ...base, kind: 'reasoning.delta', sequence: 2, attempt: 1, text: 'new thought' };
          yield { ...base, kind: 'reasoning.signature', sequence: 3, attempt: 1, signature: 'new-signature' };
          yield { ...base, kind: 'text.delta', sequence: 4, attempt: 1, text: 'answer' };
          yield { ...base, kind: 'tool.started', sequence: 5, attempt: 1, callId: 'call-new', name: 'lookup' };
          yield { ...base, kind: 'tool.arguments.delta', sequence: 6, attempt: 1, callId: 'call-new', delta: '{"id":"7"}' };
          yield { ...base, kind: 'tool.completed', sequence: 7, attempt: 1, callId: 'call-new' };
          yield { ...base, kind: 'usage.updated', sequence: 8, attempt: 1, usage: {
            totalInputTokens: 10, totalOutputTokens: 5, cachedInputTokens: 2, cacheWriteTokens: 1,
          } };
          yield { ...base, kind: 'response.completed', sequence: 9, attempt: 1, stopReason: 'tool_use' };
        })();
        return {
          events,
          statistics: Promise.resolve({
            firstVisibleContentLatencyMs: 12,
            generationDurationMs: 34,
          }),
        };
      },
      complete: vi.fn(),
    };
    const snapshots = new RuntimeSnapshotStore();
    snapshots.publish(snapshot());
    const artifacts = new MemoryArtifactStore();
    const port = new DefaultAgentInferencePort(gateway, snapshots, artifacts);

    expect(port.resolveReasoning({ providerId: 'provider', modelId: 'model/one' })).toEqual({
      selection: { kind: 'effort', effort: 'low' },
      source: 'model',
      nativeParameters: { reasoning_effort: 'low' },
    });

    const invokeOptions = options();
    const response = await port.invoke(agentRequest(), invokeOptions);

    expect(mapped).toMatchObject({
      model: { providerId: 'provider', modelId: 'model/one' },
      promptCacheKey: 'agent-cache-key',
      messages: [
        { role: 'system', content: [{ kind: 'text', text: 'system rules' }] },
        { role: 'user', content: [{ kind: 'text', text: 'look at this' }, { kind: 'input_image' }] },
        { role: 'assistant', content: [
          {
            kind: 'reasoning',
            item: { protocol: 'anthropic-thinking', text: 'prior thought', signature: 'signed' },
          },
          {
            kind: 'reasoning',
            item: { protocol: 'anthropic-redacted', data: 'prior-redacted' },
          },
          { kind: 'tool_call', callId: 'call-old', name: 'lookup', arguments: '{"id":"42"}' },
        ] },
        { role: 'tool', toolCallId: 'call-old', isError: false, content: [
          { kind: 'text', text: 'found' },
          { kind: 'image' },
        ] },
      ],
      tools: [{ name: 'lookup', inputSchema: { type: 'object', required: ['id'] } }],
      generation: { maxOutputTokens: 100, reasoning: { kind: 'effort', effort: 'high' } },
    });
    expect(response).toEqual({
      content: [
        { type: 'thinking', thinking: 'new thought', signature: 'new-signature' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'call-new', name: 'lookup', input: { id: '7' } },
      ],
      requestInfo: {
        version: 1,
        requestId: invokeOptions.requestId,
        runId: expect.stringMatching(/^ai-/),
        model: 'provider::model/one',
        stopReason: 'tool_use',
        latencyMs: expect.any(Number),
        firstVisibleContentLatencyMs: 12,
        generationDurationMs: 34,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: undefined,
        },
        effectiveReasoning: {
          selection: { kind: 'effort', effort: 'high' },
          source: 'agent',
          nativeParameters: { reasoning_effort: 'high' },
        },
      },
    });
    expect(port.contextWindow({ providerId: 'provider', modelId: 'model/one' })).toBe(200_000);
  });

  it('round-trips opaque OpenAI reasoning and function item metadata into the next request', async () => {
    const requests: DomainAiRequest[] = [];
    const gateway: AiGateway = {
      open: (request, context) => {
        requests.push(request);
        const events = (async function* (): AsyncIterable<AiEvent> {
          const base = { runId: context.runId, emittedAt: 1, attempt: 1 };
          yield { ...base, kind: 'response.started', sequence: 1, model: request.model, configRevision: 5 };
          if (requests.length === 1) {
            yield { ...base, kind: 'reasoning.delta', sequence: 2, text: 'Inspect first.' };
            yield {
              ...base,
              kind: 'reasoning.item',
              sequence: 3,
              item: {
                protocol: 'openai-responses',
                id: 'rs_1',
                summary: [{ type: 'summary_text', text: 'Inspect first.' }],
                encryptedContent: 'encrypted-state',
                status: 'completed',
              },
            };
            yield {
              ...base,
              kind: 'tool.started',
              sequence: 4,
              callId: 'call_1',
              name: 'inspect',
              providerItemId: 'fc_1',
              status: 'in_progress',
            };
            yield {
              ...base,
              kind: 'tool.arguments.delta',
              sequence: 5,
              callId: 'call_1',
              delta: '{}',
            };
            yield { ...base, kind: 'tool.completed', sequence: 6, callId: 'call_1' };
            yield { ...base, kind: 'response.completed', sequence: 7, stopReason: 'tool_use' };
          } else {
            yield { ...base, kind: 'response.completed', sequence: 2, stopReason: 'end_turn' };
          }
        })();
        return { events, statistics: Promise.resolve({}) };
      },
      complete: vi.fn(),
    };
    const snapshots = new RuntimeSnapshotStore();
    snapshots.publish(snapshot());
    const port = new DefaultAgentInferencePort(gateway, snapshots, new MemoryArtifactStore());

    const first = await port.invoke(
      { ...agentRequest(), systemPrompt: '', messages: [] },
      options(),
    );
    expect(first.content).toEqual([
      {
        type: 'openai_reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Inspect first.' }],
        encrypted_content: 'encrypted-state',
        status: 'completed',
      },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'inspect',
        input: {},
        provider_item_id: 'fc_1',
        status: 'completed',
      },
    ]);

    await port.invoke(
      {
        ...agentRequest(),
        systemPrompt: '',
        messages: [
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] },
        ],
      },
      options(),
    );

    expect(requests[1]!.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            kind: 'reasoning',
            item: {
              protocol: 'openai-responses',
              id: 'rs_1',
              summary: [{ type: 'summary_text', text: 'Inspect first.' }],
              encryptedContent: 'encrypted-state',
              status: 'completed',
            },
          },
          {
            kind: 'tool_call',
            callId: 'call_1',
            name: 'inspect',
            arguments: '{}',
            providerItemId: 'fc_1',
            status: 'completed',
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ kind: 'text', text: 'done' }] },
    ]);
  });

  it('forwards retry lifecycle facts while retaining the new Gateway as the only retry owner', async () => {
    const retryError = new GatewayCallError({
      source: 'provider',
      gateway: 'ai',
      providerId: 'provider',
      modelId: 'model/one',
      driverId: 'openai',
      stage: 'request',
      attempt: 1,
      traceId: 'trace',
      message: 'rate limited',
      upstream: { status: 429, message: 'rate limited', body: { error: 'rate limited' } },
    });
    const gateway: AiGateway = {
      open: (request, context) => ({
        events: (async function* (): AsyncIterable<AiEvent> {
          const base = { runId: context.runId, emittedAt: 1 };
          yield { ...base, kind: 'response.started', sequence: 1, attempt: 1, model: request.model, configRevision: 5 };
          yield { ...base, kind: 'text.delta', sequence: 2, attempt: 1, text: 'partial' };
          yield { ...base, kind: 'response.retrying', sequence: 3, attempt: 1, retryAt: 1234, error: retryError };
          yield { ...base, kind: 'text.delta', sequence: 4, attempt: 2, text: 'ok' };
          yield { ...base, kind: 'response.completed', sequence: 5, attempt: 2, stopReason: 'end_turn' };
        })(),
        statistics: Promise.resolve({}),
      }),
      complete: vi.fn(),
    };
    const snapshots = new RuntimeSnapshotStore();
    snapshots.publish(snapshot());
    const port = new DefaultAgentInferencePort(gateway, snapshots, new MemoryArtifactStore());
    const onAttemptStart = vi.fn();
    const onBackoff = vi.fn();
    const visible: VisibleDelta[] = [];

    const response = await port.invoke(
      { ...agentRequest(), messages: [] },
      options({
        onAttemptStart,
        onBackoff,
        onVisibleDelta: (delta) => visible.push(delta),
      }),
    );

    expect(onAttemptStart).toHaveBeenNthCalledWith(1, { attempt: 0, maxAttempts: 2 });
    expect(onAttemptStart).toHaveBeenNthCalledWith(2, { attempt: 1, maxAttempts: 2 });
    expect(onBackoff).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      maxAttempts: 2,
      errorType: AIErrorType.RATE_LIMIT,
      retryAt: 1234,
      errorMessage: 'rate limited',
    }));
    expect(visible).toEqual([
      { runId: response.requestInfo.runId, attempt: 1, sequence: 1, kind: 'text', delta: 'partial' },
      { runId: response.requestInfo.runId, attempt: 2, sequence: 2, kind: 'text', delta: 'ok' },
    ]);
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('emits only non-empty visible deltas with an independent sequence', async () => {
    const gateway: AiGateway = {
      open: (request) => ({
        events: (async function* (): AsyncIterable<AiEvent> {
          const base = { runId: 'stable-run', emittedAt: 100, attempt: 1 };
          yield { ...base, kind: 'response.started', sequence: 1, model: request.model, configRevision: 5 };
          yield { ...base, kind: 'reasoning.delta', sequence: 2, text: '' };
          yield { ...base, kind: 'reasoning.delta', sequence: 3, text: 'think' };
          yield { ...base, kind: 'tool.started', sequence: 4, callId: 'call-1', name: 'lookup' };
          yield { ...base, kind: 'tool.arguments.delta', sequence: 5, callId: 'call-1', delta: '{"id":"1"}' };
          yield { ...base, kind: 'tool.completed', sequence: 6, callId: 'call-1' };
          yield { ...base, kind: 'text.delta', sequence: 7, text: '' };
          yield { ...base, kind: 'text.delta', sequence: 8, text: 'answer' };
          yield { ...base, kind: 'response.completed', sequence: 9, stopReason: 'tool_use' };
        })(),
        statistics: Promise.resolve({
          firstVisibleContentLatencyMs: 10,
          generationDurationMs: 20,
        }),
      }),
      complete: vi.fn(),
    };
    const snapshots = new RuntimeSnapshotStore();
    snapshots.publish(snapshot());
    const port = new DefaultAgentInferencePort(gateway, snapshots, new MemoryArtifactStore());
    const request = { ...agentRequest(), messages: [] };
    const baseOptions = { requestId: 'stable-request', logicalStartedAt: 50 };
    const visible: unknown[] = [];

    vi.useFakeTimers();
    vi.setSystemTime(100);
    try {
      const withoutObserver = await port.invoke(request, baseOptions);
      const withObserver = await port.invoke(request, {
        ...baseOptions,
        onVisibleDelta: (delta) => visible.push(delta),
      });
      const withThrowingObservers = await port.invoke(request, {
        ...baseOptions,
        onAttemptStart: () => { throw new Error('attempt observer failed'); },
        onVisibleDelta: () => { throw new Error('visible observer failed'); },
      });

      expect(withObserver).toEqual(withoutObserver);
      expect(withThrowingObservers).toEqual(withoutObserver);
      expect(visible).toEqual([
        { runId: 'stable-run', attempt: 1, sequence: 1, kind: 'think', delta: 'think' },
        { runId: 'stable-run', attempt: 1, sequence: 2, kind: 'text', delta: 'answer' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unknown structured target instead of choosing another model', () => {
    const gateway = { open: vi.fn(), complete: vi.fn() } as unknown as AiGateway;
    const snapshots = new RuntimeSnapshotStore();
    snapshots.publish(snapshot());
    const port = new DefaultAgentInferencePort(gateway, snapshots, new MemoryArtifactStore());

    expect(() => port.assertTarget({ providerId: 'provider', modelId: 'missing' })).toThrow('not found');
    expect(gateway.open).not.toHaveBeenCalled();
  });

  it('does not manufacture a context window when the configured model omits it', () => {
    const gateway = { open: vi.fn(), complete: vi.fn() } as unknown as AiGateway;
    const snapshots = new RuntimeSnapshotStore();
    const missingLimit = snapshot();
    const catalogModel = missingLimit.catalogModels.get('catalog/chat')!;
    missingLimit.catalogModels = new Map([['catalog/chat', { ...catalogModel, limits: {} }]]);
    snapshots.publish(missingLimit);
    const port = new DefaultAgentInferencePort(gateway, snapshots, new MemoryArtifactStore());

    expect(() => port.contextWindow({ providerId: 'provider', modelId: 'model/one' }))
      .toThrow('missing limits.contextWindow');
  });

  it.each(['content_filter', 'other'] as const)('preserves the %s provider stop reason', async (stopReason) => {
    const gateway: AiGateway = {
      open: (request, context) => ({
        events: (async function* (): AsyncIterable<AiEvent> {
          const base = { runId: context.runId, emittedAt: 1, attempt: 1 };
          yield { ...base, kind: 'response.started', sequence: 1, model: request.model, configRevision: 5 };
          yield { ...base, kind: 'response.completed', sequence: 2, stopReason };
        })(),
        statistics: Promise.resolve({}),
      }),
      complete: vi.fn(),
    };
    const snapshots = new RuntimeSnapshotStore();
    snapshots.publish(snapshot());
    const port = new DefaultAgentInferencePort(gateway, snapshots, new MemoryArtifactStore());

    const response = await port.invoke({ ...agentRequest(), messages: [] }, options());

    expect(response.requestInfo.stopReason).toBe(stopReason);
  });
});
