import type { UsageFilter, UsageRecord, UsageSummary, UsageTokens } from './types/model-usage.js';

export function knownTokens(usage: UsageTokens): number {
  return (usage.totalInputTokens ?? 0) + (usage.totalOutputTokens ?? 0);
}

export function emptyUsageSummary(): UsageSummary {
  return { calls: 0, requests: 0, success: 0, running: 0, input: 0, output: 0, tokens: 0,
    inputSamples: 0, outputSamples: 0, cacheReadSamples: 0,
    cacheRead: 0, cacheWrite: 0, reasoning: 0, completeUsage: 0, partialUsage: 0,
    cacheSamples: 0, cacheInput: 0, cacheHit: 0,
    latencySamples: 0, latencyTotal: 0, firstResponseSamples: 0, firstResponseTotal: 0 };
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  const summary = emptyUsageSummary();
  const requests = new Set<string>();
  for (const r of records) {
    addUsageRecord(summary, r);
    requests.add(usageRequestKey(r));
  }
  summary.requests = requests.size;
  return summary;
}

export function addUsageRecord(s: UsageSummary, r: UsageRecord): void {
  s.calls++;
  if (r.status === 'success') s.success++;
  if (r.status === 'running') s.running++;
  const u = r.usage;
  s.input += u.totalInputTokens ?? 0;
  s.output += u.totalOutputTokens ?? 0;
  if (u.totalInputTokens !== undefined) s.inputSamples++;
  if (u.totalOutputTokens !== undefined) s.outputSamples++;
  if (u.cachedInputTokens !== undefined) s.cacheReadSamples++;
  s.tokens += knownTokens(u);
  s.cacheRead += u.cachedInputTokens ?? 0;
  s.cacheWrite += u.cacheWriteTokens ?? 0;
  s.reasoning += u.reasoningTokens ?? 0;
  if (u.totalInputTokens !== undefined && u.totalOutputTokens !== undefined) s.completeUsage++;
  else if (Object.values(u).some((value) => value !== undefined)) s.partialUsage++;
  if (u.totalInputTokens !== undefined && u.cachedInputTokens !== undefined) {
    s.cacheSamples++;
    s.cacheInput += u.totalInputTokens;
    s.cacheHit += u.cachedInputTokens;
  }
  if (r.endedAt !== undefined) {
    s.latencySamples++;
    s.latencyTotal += Math.max(0, r.endedAt - r.startedAt);
  }
  if (r.firstResponseMs !== undefined) {
    s.firstResponseSamples++;
    s.firstResponseTotal += r.firstResponseMs;
  }
}

export function matchesUsage(r: UsageRecord, f: UsageFilter): boolean {
  if (f.from !== undefined && r.startedAt < f.from) return false;
  if (f.to !== undefined && r.startedAt >= f.to) return false;
  if (f.modelTarget !== undefined && usageModelTarget(r) !== f.modelTarget) return false;
  return (['mainAgentId', 'providerId', 'agentType', 'agentId', 'purpose', 'status', 'protocol', 'reasoning', 'requestId'] as const)
    .every((key) => f[key] === undefined || (r[key] ?? '') === f[key]);
}

export function usageModelTarget(record: Pick<UsageRecord, 'providerId' | 'modelId'>): string {
  return JSON.stringify([record.providerId, record.modelId]);
}

export function usageRequestKey(record: Pick<UsageRecord, 'mainAgentId' | 'agentId' | 'requestId' | 'runId'>): string {
  return JSON.stringify([record.mainAgentId, record.agentId, record.requestId ?? record.runId]);
}
