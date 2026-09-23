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
import type { AgentInferencePort } from '../../../inference/application/agent-inference-port.js';

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
      provider: 'Provider 名称', model: '模型名称', output: '输出 Token（含推理）', input: '输入 Token（含缓存）', duration: '总耗时（毫秒）' },
    { language: 'en-US', time: 'Call time (UTC)', purpose: 'Purpose', compaction: 'Compaction', status: 'Status', success: 'Success',
      provider: 'Provider name', model: 'Model name', output: 'Output tokens (including reasoning)', input: 'Input tokens (including cache)', duration: 'Total duration (ms)' },
  ] as const)('exports readable $language labels while preserving numbers and unknown values', async (labels) => {
    const usage = service();
    usage.store.append(fixture({ purpose: 'compaction', usage: { totalInputTokens: 0 }, endedAt: now + 1250 }));
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
      [labels.provider]: 'Provider', [labels.model]: 'Model', [labels.input]: '0', [labels.output]: '', [labels.duration]: '1250',
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

describe('gateway collection boundary', () => {
  it('captures every retry and never persists prompt or error body', async () => {
    const usage = service();
    const snapshots = new RuntimeSnapshotStore();
    const target: CompiledTarget = { ref: { providerId: 'p', modelId: 'm' }, driverId: 'fake', upstreamModel: 'm', catalogId: 'm', configRevision: 1,
      ai: { openAttempt: async function* (_request, context): AsyncIterable<AiAttemptEvent> {
        if (context.attempt === 1) throw new GatewayCallError({ source: 'transport', gateway: 'ai', providerId: 'p', modelId: 'm', driverId: 'fake', stage: 'connect', attempt: 1, traceId: 'trace', message: 'SECRET', upstream: { message: 'SECRET', body: 'SECRET' } });
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
    observer.event({ kind: 'response.completed', runId: 'r', attempt: 1, sequence: 1, emittedAt: now, stopReason: 'end_turn' });
    await expect(Promise.resolve(observer.close(now))).resolves.toBeUndefined();
    await usage.store.flush();
    expect(usage.store.writeError).toBeDefined();
  });
});
