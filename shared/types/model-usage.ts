/** Reporting metadata; never sent to an inference provider. */
export interface UsageAttribution {
  mainAgentId?: string;
  agentId?: string;
  agentType?: string;
  runName?: string;
  requestId?: string;
  purpose: 'inference' | 'compaction' | 'test';
}

export interface ModelUsageConfig {
  schemaVersion: 1;
  revision: number;
  /** null means keep indefinitely. Includes the current UTC day. */
  retentionDays: 30 | 90 | 180 | 365 | null;
}

export type UsageStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
export interface UsageTokens {
  totalInputTokens?: number;
  totalOutputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface UsageRecord extends UsageAttribution {
  schemaVersion: 1;
  /** Derived from gateway runId + attempt, distinct from tool callId. */
  id: string;
  runId: string;
  attempt: number;
  startedAt: number;
  endedAt?: number;
  firstResponseMs?: number;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  protocol: string;
  reasoning?: string;
  configRevision: number;
  status: UsageStatus;
  usage: UsageTokens;
  error?: { source: string; stage: string; code?: string; httpStatus?: number };
}

export interface UsageFilter {
  from?: number;
  to?: number;
  mainAgentId?: string;
  providerId?: string;
  /** Serialized [providerId, modelId], referring to the existing ModelTarget. */
  modelTarget?: string;
  agentType?: string;
  agentId?: string;
  purpose?: UsageAttribution['purpose'];
  status?: UsageStatus;
  protocol?: string;
  reasoning?: string;
  requestId?: string;
}

export interface UsageSummary {
  calls: number;
  requests: number;
  success: number;
  running: number;
  input: number;
  output: number;
  inputSamples: number;
  outputSamples: number;
  cacheReadSamples: number;
  tokens: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  completeUsage: number;
  partialUsage: number;
  cacheSamples: number;
  cacheInput: number;
  cacheHit: number;
  latencySamples: number;
  latencyTotal: number;
  firstResponseSamples: number;
  firstResponseTotal: number;
}

export type UsageDimension = 'modelId' | 'providerId' | 'mainAgentId' | 'agentType' | 'purpose';
export interface UsageGroup { id: string; label: string; summary: UsageSummary }
export interface UsageFacet { id: string; label: string }
export type UsageFacets = Record<'mainAgentId' | 'providerId' | 'modelTarget' | 'agentType' | 'agentId' | 'protocol' | 'reasoning', UsageFacet[]>;
export interface UsageStorageStatus {
  revision: number;
  bytes: number;
  files: number;
  earliestDay?: string;
  latestDay?: string;
  lastCleanupAt?: number;
  writeError?: string;
}
export interface UsageReport {
  snapshotId: string;
  createdAt: number;
  revision: number;
  filter: UsageFilter;
  summary: UsageSummary;
  groups: Record<UsageDimension, UsageGroup[]>;
  trend: { at: number; to: number; summary: UsageSummary }[];
  facets: UsageFacets;
  storage: UsageStorageStatus;
  corruptLines: number;
  records: UsageRecord[];
  total: number;
}
export type UsageSort = 'startedAt' | 'tokens' | 'duration';
export interface UsagePage { records: UsageRecord[]; total: number }
export interface UsageCleanupPreview {
  cutoff?: string;
  files: number;
  records: number;
  bytes: number;
  skippedFiles: number;
}
