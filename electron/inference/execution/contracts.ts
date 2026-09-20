export interface ModelTarget {
  providerId: string;
  modelId: string;
}

export interface ArtifactRef {
  artifactId: string;
}

export interface RunContext {
  usage?: import('../../../shared/types/model-usage.js').UsageAttribution;
  runId: string;
  traceId: string;
  signal: AbortSignal;
  deadlineAt?: number;
}

export interface AttemptContext extends RunContext {
  attempt: number;
  configRevision: number;
  connectTimeoutMs: number;
}
