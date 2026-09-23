import { createUuid } from '@shared/utils/identifiers.js';
import type { AppSettings } from '../../../shared/types/index.js';
import type { ModelUsageConfig, UsageCleanupPreview, UsageDimension, UsageFacets, UsageFilter, UsageGroup, UsagePage, UsageRecord, UsageReport, UsageSort } from '../../../shared/types/model-usage.js';
import { knownTokens, matchesUsage, summarizeUsage, usageModelTarget, usageRequestKey } from '../../../shared/model-usage.js';
import { configFileWriter } from '../../config/core/atomic-file-writer.js';
import { defaultModelUsageConfig } from '../../config/domains/model-usage.adapter.js';
import type { AiUsageObserverFactory } from '../../inference/ai/usage-observer.js';
import { FileUsageStore } from './file-usage-store.js';
import { formatUsageCsv } from './usage-csv.js';

const DAY = 86_400_000;
const SNAPSHOT_LIMIT = 100_000;
const dimensions: UsageDimension[] = ['modelId', 'providerId', 'mainAgentId', 'agentType', 'purpose'];
type Snapshot = { records: UsageRecord[]; createdAt: number };

export class ModelUsageService {
  readonly store: FileUsageStore;
  private config = defaultModelUsageConfig();
  private configError = false;
  private timer?: NodeJS.Timeout;
  private cleanupFlight?: Promise<void>;
  private closed = false;
  private snapshots = new Map<string, Snapshot>();
  private refreshTail: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string, private readonly readConfig: () => Promise<ModelUsageConfig>, private readonly now = Date.now) {
    this.store = new FileUsageStore(rootDirectory, now);
  }

  refreshConfig(): Promise<void> {
    const task = this.refreshTail.then(async () => {
      try { this.configure(await this.readConfig()); }
      catch { this.configError = true; }
    });
    this.refreshTail = task;
    return task;
  }

  configure(config: ModelUsageConfig): void {
    if (config.revision >= this.config.revision) this.config = structuredClone(config);
    this.configError = false;
  }

  async start(): Promise<void> {
    await this.refreshConfig();
    // Every launch checks once. No persisted cleanup clock or extra runtime file.
    this.cleanupFlight = this.automaticCleanup();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.cleanupFlight;
    await this.refreshTail;
    await this.store.flush();
    this.snapshots.clear();
  }

  readonly observe: AiUsageObserverFactory = (request, context, target) => {
    let record: UsageRecord | undefined;
    const persist = () => { if (record) this.store.append(record); };
    const finish = (status: UsageRecord['status'], at: number) => {
      if (!record || record.status !== 'running') return;
      record.status = status;
      record.endedAt = at;
      persist();
    };
    return {
      attemptStarted: (at, attempt) => {
        const attribution = context.usage ?? { purpose: 'inference' as const };
        const reasoning = request.generation?.reasoning;
        record = {
          schemaVersion: 1, ...attribution, id: `${context.runId}:${attempt}`,
          runId: context.runId, attempt, startedAt: at,
          providerId: target.ref.providerId, providerName: target.providerName ?? target.ref.providerId,
          modelId: target.ref.modelId, modelName: target.modelDefinition?.displayName ?? target.ref.modelId,
          protocol: target.protocol ?? target.driverId,
          reasoning: reasoning ? ('effort' in reasoning ? reasoning.effort : 'tokens' in reasoning ? String(reasoning.tokens) : reasoning.kind) : undefined,
          configRevision: target.configRevision, status: 'running', usage: {},
        };
        this.store.track(record);
        persist();
      },
      event: (event) => {
        if (!record || event.attempt !== record.attempt || record.status !== 'running') return;
        if ((event.kind === 'text.delta' || event.kind === 'reasoning.delta') && event.text.length && record.firstResponseMs === undefined) {
          record.firstResponseMs = Math.max(0, event.emittedAt - record.startedAt);
        }
        if (event.kind === 'usage.updated') {
          record.usage = { ...record.usage, ...Object.fromEntries(Object.entries(event.usage).filter(([, value]) => value !== undefined)) };
          persist();
        }
        if (event.kind === 'response.failed' || event.kind === 'response.retrying') {
          // No provider body/message: those may contain prompts, headers or credentials.
          record.error = { source: event.error.source, stage: event.error.stage,
            code: event.error.localCode ?? event.error.upstream?.code?.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100),
            httpStatus: event.error.upstream?.status };
          finish('failed', event.emittedAt);
        }
        if (event.kind === 'response.cancelled') finish('cancelled', event.emittedAt);
        if (event.kind === 'response.completed') finish('success', event.emittedAt);
      },
      close: (at) => { finish('interrupted', at); },
    };
  };

  async query(filter: UsageFilter, signal?: AbortSignal): Promise<UsageReport> {
    const records: UsageRecord[] = [];
    const facetMaps = Object.fromEntries(['mainAgentId', 'providerId', 'modelTarget', 'agentType', 'agentId', 'protocol', 'reasoning']
      .map((key) => [key, new Map<string, string>()])) as Record<keyof UsageFacets, Map<string, string>>;
    return this.store.read(filter, (day) => {
      for (const record of day) {
        if (!matchesUsage(record, { from: filter.from, to: filter.to })) continue;
        for (const key of Object.keys(facetMaps) as (keyof UsageFacets)[]) {
          const id = key === 'modelTarget' ? usageModelTarget(record) : record[key] ?? '';
          facetMaps[key].set(id, groupLabel(record, key));
          if (facetMaps[key].size > 25_000) throw new Error('Too many filter choices in this date range. Narrow the date range to continue.');
        }
        if (matchesUsage(record, filter)) records.push(record);
        if (records.length > SNAPSHOT_LIMIT) throw new Error('Too many matching calls. Narrow the date range or select a session before querying.');
      }
    }, (storage, corruptLines) => {
      const createdAt = this.now();
      const snapshotId = createUuid();
      records.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
      // At most two immutable snapshots; no persistent index or aggregate files.
      for (const [id, snapshot] of this.snapshots) {
        if (createdAt - snapshot.createdAt > 30 * 60_000) this.snapshots.delete(id);
      }
      while (this.snapshots.size >= 2) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(snapshotId, { records, createdAt });
      const groups = Object.fromEntries(dimensions.map((dimension) => [dimension, grouped(records, dimension)])) as Record<UsageDimension, UsageGroup[]>;
      const min = records.at(-1)?.startedAt ?? createdAt;
      const max = records[0]?.startedAt ?? createdAt;
      const bucket = max - min <= 2 * DAY ? 3_600_000 : max - min <= 120 * DAY ? DAY : Math.max(7, Math.ceil((max - min) / DAY / 512)) * DAY;
      const trendRecords = new Map<number, UsageRecord[]>();
      for (const record of records) {
        const at = Math.floor(record.startedAt / bucket) * bucket;
        const items = trendRecords.get(at) ?? [];
        items.push(record); trendRecords.set(at, items);
      }
      if (records.length) {
        for (let at = Math.floor(min / bucket) * bucket; at <= max; at += bucket) {
          if (!trendRecords.has(at)) trendRecords.set(at, []);
        }
      }
      return { snapshotId, createdAt, revision: storage.revision, filter: { ...filter },
        summary: summarizeUsage(records), groups,
        trend: [...trendRecords].sort(([a], [b]) => a - b).map(([at, items]) => ({ at, to: at + bucket, summary: summarizeUsage(items) })),
        facets: Object.fromEntries(Object.entries(facetMaps).map(([key, map]) => [key, [...map].map(([id, label]) => ({ id, label }))])) as UsageFacets,
        storage: { ...storage, ...(this.configError && { writeError: 'Usage configuration is unavailable; automatic cleanup is paused.' }) },
        corruptLines, records: records.slice(0, 50), total: records.length };
    }, signal);
  }

  page(snapshotId: string, offset: number, sort: UsageSort = 'startedAt', descending = true): UsagePage {
    const records = [...this.snapshot(snapshotId).records];
    const value = (r: UsageRecord) => sort === 'tokens' ? knownTokens(r.usage) : sort === 'duration' ? (r.endedAt === undefined ? -1 : r.endedAt - r.startedAt) : r.startedAt;
    records.sort((a, b) => (value(b) - value(a)) * (descending ? 1 : -1) || a.id.localeCompare(b.id));
    return { records: records.slice(offset, offset + 50), total: records.length };
  }

  detail(snapshotId: string, id: string): { record: UsageRecord; related: UsageRecord[] } {
    const records = this.snapshot(snapshotId).records;
    const record = records.find((r) => r.id === id);
    if (!record) throw new Error('Usage record not found in this snapshot. Refresh the report.');
    return { record, related: records.filter((r) => usageRequestKey(r) === usageRequestKey(record)).sort((a, b) => a.startedAt - b.startedAt) };
  }

  async export(snapshotId: string, filePath: string, language: AppSettings['language']): Promise<number> {
    // Capture the immutable snapshot before awaiting disk I/O. Cleanup cannot alter this export.
    const records = this.snapshot(snapshotId).records;
    await configFileWriter.replace(filePath, formatUsageCsv(records, language));
    return records.length;
  }

  preview(days: number | null, all = false): Promise<UsageCleanupPreview> { return this.store.cleanup(days, false, all); }
  async cleanup(all = false): Promise<UsageCleanupPreview> {
    await this.refreshConfig();
    if (this.configError && !all) throw new Error('Usage retention configuration is unavailable.');
    const result = await this.store.cleanup(this.config.retentionDays, true, all);
    if (result.files) this.snapshots.clear();
    return result;
  }

  private snapshot(id: string): Snapshot {
    const snapshot = this.snapshots.get(id);
    if (!snapshot || this.now() - snapshot.createdAt > 30 * 60_000) {
      this.snapshots.delete(id);
      throw new Error('Usage snapshot expired. Refresh the report to continue.');
    }
    return snapshot;
  }

  private async automaticCleanup(): Promise<void> {
    let delay = DAY;
    try { await this.cleanup(); } catch { delay = 3_600_000; }
    if (!this.closed) {
      this.timer = setTimeout(() => { this.cleanupFlight = this.automaticCleanup(); }, delay);
      this.timer.unref();
    }
  }
}

function groupLabel(record: UsageRecord, key: string): string {
  if (key === 'mainAgentId') return record.runName || record.mainAgentId || '';
  if (key === 'providerId') return record.providerName;
  if (key === 'modelId' || key === 'modelTarget') return `${record.modelName} · ${record.providerName}`;
  return String(record[key as keyof UsageRecord] ?? '');
}
function grouped(records: UsageRecord[], dimension: UsageDimension): UsageGroup[] {
  const groups = new Map<string, { label: string; records: UsageRecord[] }>();
  for (const record of records) {
    const id = dimension === 'modelId' ? usageModelTarget(record) : record[dimension] ?? '';
    const group = groups.get(id) ?? { label: groupLabel(record, dimension), records: [] };
    group.records.push(record); groups.set(id, group);
  }
  return [...groups].map(([id, group]) => ({ id, label: group.label, summary: summarizeUsage(group.records) }));
}
