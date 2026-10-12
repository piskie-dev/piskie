import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecord } from '../../../../shared/types/model-usage.js';
import { summarizeUsage, usageModelTarget } from '../../../../shared/model-usage.js';
import { defaultModelUsageConfig, createModelUsageDomain } from '../../../config/domains/model-usage.adapter.js';
import { FileUsageStore, usageCutoff } from '../file-usage-store.js';
import { ModelUsageService } from '../model-usage-service.js';
import { DefaultAiGateway } from '../../../inference/ai/public-gateway.js';
import { RuntimeSnapshotStore, type CompiledTarget } from '../../../inference/execution/runtime-snapshot.js';
import { GatewayCallError } from '../../../inference/execution/call-error.js';
import type { AiAttemptEvent } from '../../../inference/ai/contracts.js';
import { attributedInferencePort } from '../../../inference/application/attributed-inference-port.js';
import { DefaultAgentInferencePort, type AgentInferencePort } from '../../../inference/application/agent-inference-port.js';
import { MemoryArtifactStore } from '../../../inference/image/artifact-store.js';
import { AgentActivityTracker } from '../../../agent/run-metrics.js';
import { averageOutputThroughput } from '../../../../shared/agent-output-throughput.js';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { projectOpenAiChatStream } from '../../../inference/drivers/openai/event-projector.js';
import { projectOpenAiResponsesStream } from '../../../inference/drivers/openai/responses-event-projector.js';
import { projectAnthropicMessagesStream } from '../../../inference/drivers/anthropic-messages/event-projector.js';
import { formatUsageCsv } from '../usage-csv.js';

let root: string;
const now = Date.parse('2026-09-18T12:00:00Z');
const services: ModelUsageService[] = [];
const fixture = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  schemaVersion: 1, id: 'ai-one:1', runId: 'ai-one', attempt: 1, startedAt: now,
  mainAgentId: 'session-1', agentId: 'worker-1', agentType: 'explore', runName: 'First session',
  purpose: 'inference', requestId: 'turn-1', providerId: 'p', providerName: 'Provider', modelId: 'm', modelName: 'Model',
  protocol: 'test', configRevision: 1, status: 'success', usage: {}, ...overrides,
});
function service(config = defaultModelUsageConfig()) {
  const value = new ModelUsageService(root, async () => config, () => now);
  services.push(value); return value;
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-usage-')); });
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(services.splice(0).map((s) => s.close()));
  await fs.rm(root, { recursive: true, force: true });
});

describe('model usage facts', () => {
  it('derives a provider budget from latest attempt facts without affecting other providers', async () => {
    const resetAt = Date.parse('2026-09-21T00:00:00Z');
    const usage = service({ ...defaultModelUsageConfig(), providerBudgets: {
      p: { period: 'weekly', limit: 1_000, resetAt },
    } });
    await usage.refreshConfig();
    usage.store.append(fixture({ usage: { totalInputTokens: 100, totalOutputTokens: 20, cachedInputTokens: 80 } }));
    usage.store.append(fixture({ usage: { totalInputTokens: 200, totalOutputTokens: 30, cachedInputTokens: 80 } }));
    usage.store.append(fixture({ id: 'retry:2', runId: 'retry', attempt: 2, status: 'failed',
      usage: { totalInputTokens: 50, totalOutputTokens: 10 } }));
    usage.store.append(fixture({ id: 'other:1', runId: 'other', providerId: 'other',
      usage: { totalInputTokens: 500, totalOutputTokens: 500 } }));
    expect(await usage.budget('p')).toMatchObject({ used: 290, remaining: 710, complete: true, unmeasuredCalls: 0 });
    expect(await usage.budget('other')).toBeNull();
  });

  it('does not present an exact remainder when usage is missing', async () => {
    const usage = service({ ...defaultModelUsageConfig(), providerBudgets: {
      p: { period: 'monthly', limit: 1000, resetAt: Date.parse('2026-10-01T00:00:00Z') },
    } });
    await usage.refreshConfig();
    usage.store.append(fixture({ usage: { totalInputTokens: 100 } }));
    expect(await usage.budget('p')).toMatchObject({ used: 100, complete: false, unmeasuredCalls: 1 });
    expect((await usage.budget('p'))?.remaining).toBeUndefined();
  });

  it('does not present an exact remainder when retention can remove part of the period', async () => {
    const usage = service({ ...defaultModelUsageConfig(), retentionDays: 30, providerBudgets: {
      p: { period: 'monthly', limit: 1000, resetAt: Date.parse('2026-09-19T00:00:00Z') },
    } });
    await usage.refreshConfig();
    usage.store.append(fixture({ usage: { totalInputTokens: 100, totalOutputTokens: 20 } }));
    expect(await usage.budget('p')).toMatchObject({ used: 120, complete: false });
    expect((await usage.budget('p'))?.remaining).toBeUndefined();
  });

  it('updates cached days after append and rebuilds them after file replacement or truncation', async () => {
    const usage = service();
    usage.store.append(fixture({ usage: { totalInputTokens: 10 } }));
    const first = await usage.query({}); expect(first.summary.tokens).toBe(10);
    usage.store.append(fixture({ usage: { totalInputTokens: 20 } }));
    expect((await usage.query({})).summary.tokens).toBe(20);
    expect(usage.page(first.snapshotId, 0).records[0]?.usage.totalInputTokens).toBe(10);
    const file = path.join(usage.store.directory, '2026-09-18.jsonl');
    const replacement = path.join(root, 'replacement');
    await fs.writeFile(replacement, JSON.stringify(fixture({ usage: { totalInputTokens: 30 } })) + '\n');
    await fs.rename(replacement, file);
    expect((await usage.query({})).summary.tokens).toBe(30);
    await fs.truncate(file, 0);
    expect((await usage.query({})).total).toBe(0);
  });
  it('keeps identically named model bindings and requests in different owners distinct', async () => {
    const usage = service();
    const a = fixture();
    const b = fixture({ id: 'ai-two:1', runId: 'ai-two', providerId: 'other', providerName: 'Other', mainAgentId: 'session-2', agentId: 'worker-2' });
    usage.store.append(a); usage.store.append(b);
    const report = await usage.query({});
    expect(report.groups.modelId).toHaveLength(2);
    expect(report.summary.requests).toBe(2);
    expect(usage.detail(report.snapshotId, a.id).related).toHaveLength(1);
    expect((await usage.query({ modelTarget: usageModelTarget(a) })).total).toBe(1);
  });
  it('counts cache and reasoning only once, keeps partial data and uses matching cache samples', () => {
    const records = [fixture({ usage: { totalInputTokens: 100, totalOutputTokens: 20, cachedInputTokens: 80, reasoningTokens: 10 } }),
      fixture({ usage: { totalInputTokens: 50 }, status: 'failed' }), fixture({ usage: {}, status: 'running' })];
    expect(summarizeUsage(records)).toMatchObject({ calls: 3, requests: 1, running: 1, success: 1, tokens: 170, input: 150, output: 20,
      completeUsage: 1, partialUsage: 1, cacheSamples: 1, cacheInput: 100, cacheHit: 80, reasoning: 10 });
  });

  it('reads legacy records without exposing retired price fields or losing usage', async () => {
    const usage = service();
    await fs.mkdir(usage.store.directory, { recursive: true });
    const record = fixture({ usage: { totalInputTokens: 100, totalOutputTokens: 10, cachedInputTokens: 80, cacheWriteTokens: 0 } });
    await fs.writeFile(path.join(usage.store.directory, '2026-09-18.jsonl'), JSON.stringify({ ...record, priceRevision: 2, price: { currency: 'USD', input: 10, output: 20, cacheRead: 1 } }) + '\n');
    usage.store.append(fixture({ id: 'new:1', runId: 'new', usage: { totalInputTokens: 20, totalOutputTokens: 5 } }));
    const report = await usage.query({});
    expect(report.corruptLines).toBe(0);
    expect(report.total).toBe(2);
    expect(report.summary.tokens).toBe(135);
    expect(usage.detail(report.snapshotId, record.id).record).toEqual(record);
    for (const row of report.records) {
      expect(row).not.toHaveProperty('price');
      expect(row).not.toHaveProperty('priceRevision');
    }
    expect(report.summary).not.toHaveProperty('costs');
    expect(report.summary).not.toHaveProperty('pricedCalls');
  });

  it('replays snapshots without double counting and recovers truncated lines and interrupted calls', async () => {
    const store = new FileUsageStore(root);
    store.append(fixture({ status: 'running', usage: { totalInputTokens: 10 } }));
    store.append(fixture({ usage: { totalInputTokens: 20, totalOutputTokens: 5 } }));
    store.append(fixture({ id: 'unfinished:1', runId: 'unfinished', status: 'running' }));
    await store.flush();
    const file = path.join(store.directory, '2026-09-18.jsonl');
    await fs.appendFile(file, '{"partial"');
    store.append(fixture({ id: 'after:1', runId: 'after', requestId: 'turn-2' }));
    await store.flush();
    const report = await service().query({});
    expect(report.total).toBe(3);
    expect(report.summary.tokens).toBe(25);
    expect(report.corruptLines).toBe(1);
    expect(report.records.find((r) => r.runId === 'unfinished')?.status).toBe('interrupted');
  });

  it('shares filters across summaries, ranking, pages and immutable CSV exports', async () => {
    const usage = service();
    for (let i = 0; i < 60; i++) usage.store.append(fixture({ id: `run-${i}:1`, runId: `run-${i}`, requestId: `request-${i}`, usage: { totalInputTokens: i, totalOutputTokens: 1 } }));
    usage.store.append(fixture({ id: 'other:1', runId: 'other', mainAgentId: 'session-2', runName: '=SUM(1,2)' }));
    const report = await usage.query({ mainAgentId: 'session-1' });
    expect(report.total).toBe(60);
    expect(report.groups.mainAgentId).toHaveLength(1);
    expect(usage.page(report.snapshotId, 50).records).toHaveLength(10);
    usage.store.append(fixture({ id: 'new:1', runId: 'new' }));
    expect(usage.page(report.snapshotId, 0).total).toBe(60);
    const file = path.join(root, 'export.csv');
    expect(await usage.export(report.snapshotId, file, 'zh-CN')).toBe(60);
    const csv = await fs.readFile(file, 'utf8');
    expect(csv).not.toContain('other'); expect(csv).not.toContain('new:1');
    const all = await usage.query({});
    await usage.export(all.snapshotId, file, 'zh-CN');
    expect(await fs.readFile(file, 'utf8')).toContain("'=SUM(1,2)");
  });

  it.each([
    { language: 'zh-CN', time: '调用时间（UTC）', purpose: '用途', compaction: '上下文压缩', status: '状态', success: '成功',
      provider: 'Provider 名称', model: '模型名称', output: '输出 Token（含推理）', input: '输入 Token（含缓存）', duration: '总耗时（毫秒）', firstToken: '首 token 耗时（毫秒）' },
    { language: 'en-US', time: 'Call time (UTC)', purpose: 'Purpose', compaction: 'Compaction', status: 'Status', success: 'Success',
      provider: 'Provider name', model: 'Model name', output: 'Output tokens (including reasoning)', input: 'Input tokens (including cache)', duration: 'Total duration (ms)', firstToken: 'Time to first token (ms)' },
  ] as const)('exports readable $language labels while preserving numbers and unknown values', async (labels) => {
    const usage = service();
    usage.store.append(fixture({ purpose: 'compaction', usage: { totalInputTokens: 0 }, endedAt: now + 1250, firstTokenLatencyMs: 75 }));
    const report = await usage.query({});
    const file = path.join(root, 'localized.csv');
    await usage.export(report.snapshotId, file, labels.language);
    const csv = await fs.readFile(file, 'utf8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const [header, row] = csv.slice(1).trimEnd().split('\r\n').map((line) => line.slice(1, -1).split('","'));
    expect(header).toHaveLength(21);
    expect(csv).not.toMatch(/费用|币种|cost|currency/i);
    expect(row).toHaveLength(header!.length);
    const values = Object.fromEntries(header!.map((name, index) => [name, row![index]]));
    expect(values).toMatchObject({
      [labels.time]: '2026-09-18T12:00:00.000Z', [labels.purpose]: labels.compaction, [labels.status]: labels.success,
      [labels.provider]: 'Provider', [labels.model]: 'Model', [labels.input]: '0', [labels.output]: '', [labels.duration]: '1250', [labels.firstToken]: '75',
    });
  });

  it('keeps root ownership when a worker scopes an already scoped inference port', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: [] });
    const base = { invoke } as unknown as AgentInferencePort;
    const parent = attributedInferencePort(base, () => ({ purpose: 'inference', mainAgentId: 'main', agentId: 'main' }));
    const child = attributedInferencePort(parent, () => ({ purpose: 'inference', mainAgentId: 'main', agentId: 'worker', agentType: 'explore' }));
    await child.invoke({} as never, { requestId: 'compact', logicalStartedAt: now, usage: { purpose: 'compaction' } });
    expect(invoke.mock.calls[0]![1].usage).toEqual({ purpose: 'compaction', mainAgentId: 'main', agentId: 'worker', agentType: 'explore' });
  });
});

describe('retention lifecycle', () => {
  it('uses UTC inclusive dates and preserves active day files across midnight', async () => {
    expect(usageCutoff(90, now)).toBe('2026-06-21');
    expect(usageCutoff(null, now)).toBeUndefined();
    const usage = service();
    const old = fixture({ startedAt: Date.parse('2026-06-20T23:59:59Z'), status: 'running' });
    usage.store.track(old); usage.store.append(old);
    usage.store.append(fixture({ id: 'kept:1', runId: 'kept', startedAt: Date.parse('2026-06-21T00:00:00Z') }));
    expect(await usage.cleanup()).toMatchObject({ files: 0, skippedFiles: 1 });
    usage.store.append({ ...old, status: 'success', endedAt: now });
    const result = await usage.cleanup();
    expect(result).toMatchObject({ files: 1, records: 1, skippedFiles: 0 });
    expect(await fs.readdir(usage.store.directory)).toEqual(['2026-06-21.jsonl']);
  });

  it('checks every launch, then every 24 hours, retries failures after 1 hour without a runtime file', async () => {
    vi.useFakeTimers();
    const usage = service();
    const cleanup = vi.spyOn(usage, 'cleanup').mockResolvedValue({ files: 0, records: 0, bytes: 0, skippedFiles: 0 });
    await usage.start(); expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000 - 1); expect(cleanup).toHaveBeenCalledTimes(1);
    cleanup.mockRejectedValueOnce(new Error('locked'));
    await vi.advanceTimersByTimeAsync(1); expect(cleanup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_600_000); expect(cleanup).toHaveBeenCalledTimes(3);
    await usage.close();
    await vi.advanceTimersByTimeAsync(48 * 3_600_000); expect(cleanup).toHaveBeenCalledTimes(3);
    const next = service(); const nextCleanup = vi.spyOn(next, 'cleanup').mockResolvedValue({ files: 0, records: 0, bytes: 0, skippedFiles: 0 });
    await next.start(); expect(nextCleanup).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('invalidates deleted snapshots and retains configuration during clear-all', async () => {
    const domain = createModelUsageDomain(root); await domain.prepare();
    const usage = service(); usage.store.append(fixture());
    const snapshot = await usage.query({});
    expect(await usage.cleanup(true)).toMatchObject({ records: 1 });
    expect(() => usage.page(snapshot.snapshotId, 0)).toThrow('expired');
    expect(await domain.show()).toMatchObject({ retentionDays: 90 });
    expect((await usage.query({})).total).toBe(0);
  });
});

type TestProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

function projectTimedAttempt(protocol: TestProtocol, attempt: number): AsyncIterable<AiAttemptEvent> {
  const retry = attempt === 1;
  const chat = (delta: unknown, finishReason: string | null = null) => ({
    id: 'chat-example', object: 'chat.completion.chunk', created: 1, model: 'example-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const call = { type: 'function_call', id: 'fc_example', call_id: 'call_example', name: 'lookup', arguments: '', status: 'in_progress' };
  let frames: Array<[number, unknown]>;
  switch (protocol) {
    case 'openai-chat':
      frames = retry ? [
        [10, chat({ role: 'assistant', content: '' })],
        [25, chat({ content: 'draft' })],
      ] : [
        [150, chat({ role: 'assistant', content: '' })],
        [175, chat({ tool_calls: [{ index: 0, function: { arguments: '{"value":' } }] })],
        [200, chat({ tool_calls: [{ index: 0, id: 'call_example', function: { name: 'lookup', arguments: '1}' } }] })],
        [225, { ...chat({}, 'tool_calls'), usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }],
      ];
      break;
    case 'openai-responses':
      frames = retry ? [
        [10, { type: 'response.created', response: { output: [] } }],
        [25, { type: 'response.output_text.delta', delta: 'draft' }],
      ] : [
        [150, { type: 'response.created', response: { output: [] } }],
        [155, { type: 'response.output_item.added', output_index: 0, item: call }],
        [175, { type: 'response.function_call_arguments.delta', item_id: call.id, delta: '{"value":1}' }],
        [215, { type: 'response.output_item.done', output_index: 0, item: { ...call, arguments: '{"value":1}', status: 'completed' } }],
        [225, { type: 'response.completed', response: { output: [], usage: { input_tokens: 8, output_tokens: 3 } } }],
      ];
      break;
    case 'anthropic-messages':
      frames = retry ? [
        [10, { type: 'message_start', message: { content: [], usage: { input_tokens: 8, output_tokens: 0 } } }],
        [15, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        [25, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'draft' } }],
      ] : [
        [150, { type: 'message_start', message: { content: [], usage: { input_tokens: 8, output_tokens: 0 } } }],
        [155, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_example', name: 'lookup', input: {} } }],
        [175, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"value":1}' } }],
        [215, { type: 'content_block_stop', index: 0 }],
        [225, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }],
        [225, { type: 'message_stop' }],
      ];
      break;
  }
  const source = (async function* () {
    for (const [offset, event] of frames) {
      vi.setSystemTime(now + offset);
      yield event;
    }
    if (retry) {
      vi.setSystemTime(now + 40);
      throw new GatewayCallError({ source: 'transport', gateway: 'ai', providerId: 'p', modelId: 'm', driverId: 'test',
        stage: 'stream', attempt, traceId: 'trace-example', message: 'Temporary stream failure' });
    }
  })();
  if (protocol === 'openai-chat') return projectOpenAiChatStream(source as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>);
  if (protocol === 'openai-responses') return projectOpenAiResponsesStream(source as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>);
  return projectAnthropicMessagesStream(source as AsyncIterable<Anthropic.RawMessageStreamEvent>);
}

describe('gateway collection boundary', () => {
  it.each(['openai-chat', 'openai-responses', 'anthropic-messages'] as const)('shares $0 first token timing and final-attempt throughput across Agent and retry Usage', async (protocol) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const usage = service();
    const snapshots = new RuntimeSnapshotStore();
    const target: CompiledTarget = { ref: { providerId: 'p', modelId: 'm' }, driverId: protocol, upstreamModel: 'm', catalogId: 'm', configRevision: 1,
      ai: { openAttempt: (_request, context) => projectTimedAttempt(protocol, context.attempt) } };
    snapshots.publish({ configRevision: 1, catalogVersion: 'test', targets: new Map([['p', new Map([['m', target]])]]), createdAt: new Date(now).toISOString(),
      policies: { ai: { maxAttempts: 2, connectTimeoutMs: 1000, streamIdleTimeoutMs: 1000, retryBaseDelayMs: 100 }, image: { maxSubmitAttempts: 1, submitTimeoutMs: 1000, operationTimeoutMs: 1000, allowResubmitAfterAccepted: false } } });
    const sleep = vi.fn(async () => { vi.setSystemTime(now + 140); });
    const gateway = new DefaultAiGateway(snapshots, { sleep }, usage.observe);
    const port = new DefaultAgentInferencePort(gateway, snapshots, new MemoryArtifactStore());
    const response = await port.invoke({ model: target.ref, systemPrompt: '', messages: [], promptCacheKey: 'example-cache' },
      { requestId: 'turn-example', logicalStartedAt: now });

    expect(sleep).toHaveBeenCalledWith(100, expect.any(AbortSignal));
    expect(response.content).toMatchObject([{ type: 'tool_use', id: 'call_example', name: 'lookup', input: { value: 1 } }]);
    expect(response.requestInfo).toMatchObject({ firstTokenLatencyMs: 35, attemptDurationMs: 85, latencyMs: 225 });
    const tracker = new AgentActivityTracker();
    tracker.aiCompleted(response.requestInfo);
    expect(tracker.snapshot().runMetrics).toMatchObject({
      rounds: 1, llmDurationMs: 225, firstTokenLatencyTotalMs: 35, firstTokenSamples: 1,
      throughputDurationMs: 85, throughputOutputTokens: 3,
      coverage: { firstToken: 'complete', throughput: 'complete' },
    });
    expect(averageOutputThroughput([tracker.snapshot().runMetrics])).toBeCloseTo(3 / 0.085);
    const report = await usage.query({});
    const attempts = [...report.records].sort((a, b) => a.attempt - b.attempt);
    expect(attempts).toMatchObject([
      { attempt: 1, startedAt: now, endedAt: now + 40, firstTokenLatencyMs: 25, status: 'failed' },
      { attempt: 2, startedAt: now + 140, endedAt: now + 225, firstTokenLatencyMs: 35, status: 'success' },
    ]);
    expect(report.summary).toMatchObject({ calls: 2, requests: 1, firstTokenSamples: 2, firstTokenLatencyTotalMs: 60 });
    expect(report.groups.modelId[0]?.summary.firstTokenLatencyTotalMs).toBe(60);
    const [header, ...rows] = formatUsageCsv(attempts, 'en-US').slice(1).trimEnd().split('\r\n').map((line) => line.slice(1, -1).split('","'));
    const firstTokenColumn = header!.indexOf('Time to first token (ms)');
    expect(firstTokenColumn).toBeGreaterThanOrEqual(0);
    expect(rows.map((row) => row[firstTokenColumn])).toEqual(['25', '35']);
    const durationColumn = header!.indexOf('Total duration (ms)');
    expect(durationColumn).toBeGreaterThanOrEqual(0);
    expect(rows.map((row) => row[durationColumn])).toEqual(['40', '85']);
  });

  it('captures every retry and never persists prompt or error body', async () => {
    const usage = service();
    const snapshots = new RuntimeSnapshotStore();
    const target: CompiledTarget = { ref: { providerId: 'p', modelId: 'm' }, driverId: 'fake', upstreamModel: 'm', catalogId: 'm', configRevision: 1,
      ai: { openAttempt: async function* (_request, context): AsyncIterable<AiAttemptEvent> {
        if (context.attempt === 1) throw new GatewayCallError({ source: 'transport', gateway: 'ai', providerId: 'p', modelId: 'm', driverId: 'fake', stage: 'connect', attempt: 1, traceId: 'trace', message: 'SECRET', upstream: { message: 'SECRET', body: 'SECRET' } });
        yield { kind: 'response.first_token' };
        yield { kind: 'text.delta', text: 'SECRET completion' };
        yield { kind: 'usage.updated', usage: { totalInputTokens: 100 } };
        yield { kind: 'usage.updated', usage: { totalInputTokens: 120, totalOutputTokens: 20 } };
        yield { kind: 'response.completed', stopReason: 'end_turn' };
      } } };
    snapshots.publish({ configRevision: 1, catalogVersion: 'test', targets: new Map([['p', new Map([['m', target]])]]), createdAt: new Date(now).toISOString(),
      policies: { ai: { maxAttempts: 2, connectTimeoutMs: 1000, streamIdleTimeoutMs: 1000, retryBaseDelayMs: 1 }, image: { maxSubmitAttempts: 1, submitTimeoutMs: 1000, operationTimeoutMs: 1000, allowResubmitAfterAccepted: false } } });
    const gateway = new DefaultAiGateway(snapshots, { sleep: async () => undefined, now: () => now }, usage.observe);
    await gateway.complete({ model: target.ref, messages: [{ role: 'user', content: [{ kind: 'text', text: 'SECRET prompt' }] }] }, { runId: 'gateway', traceId: 'trace', signal: new AbortController().signal, usage: { purpose: 'test', requestId: 'probe' } });
    const report = await usage.query({});
    expect(report.total).toBe(2); expect(report.summary.tokens).toBe(140);
    expect(report.summary.requests).toBe(1); expect(report.summary.success).toBe(1);
    const stored = await fs.readFile(path.join(usage.store.directory, '2026-09-18.jsonl'), 'utf8');
    expect(stored).not.toContain('SECRET');
    expect(stored).not.toMatch(/price|cost|currency/i);
    const aborted = new AbortController(); aborted.abort();
    await expect(gateway.complete({ model: target.ref, messages: [] }, { runId: 'aborted', traceId: 'trace', signal: aborted.signal })).rejects.toThrow();
    expect((await usage.query({})).total).toBe(2);
  });

  it('does not fail a successful model call when report storage cannot be written', async () => {
    await fs.writeFile(path.join(root, 'usage'), 'not a directory');
    const usage = service();
    const observer = usage.observe({ model: { providerId: 'p', modelId: 'm' }, messages: [] }, { runId: 'r', traceId: 't', signal: new AbortController().signal }, { ref: { providerId: 'p', modelId: 'm' }, driverId: 'fake', upstreamModel: 'm', catalogId: 'm', configRevision: 1 });
    observer.attemptStarted(now, 1);
    observer.event({
      kind: 'response.completed', runId: 'r', attempt: 1, sequence: 1, emittedAt: now, stopReason: 'end_turn',
      result: {
        runId: 'r', model: { providerId: 'p', modelId: 'm' }, configRevision: 1,
        text: 'Sample answer', reasoning: '', reasoningItems: [], toolCalls: [], usage: {},
        content: [{ kind: 'text', text: 'Sample answer' }], stopReason: 'end_turn',
      },
    });
    await expect(Promise.resolve(observer.close(now))).resolves.toBeUndefined();
    await usage.store.flush();
    expect(usage.store.writeError).toBeDefined();
  });
});
