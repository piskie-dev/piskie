import type { ResourceSnapshot } from './resource-ledger.js';

export type BackendPhase =
  | 'created'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed-start'
  | 'failed-stop'
  | 'quarantined';

export interface SerializedDiagnostic {
  name: string;
  message: string;
}

export interface CapabilityUnavailable {
  componentId: string;
  reason: SerializedDiagnostic;
}

export interface ComponentBootResult {
  componentId: string;
  requirement: 'required' | 'optional';
  outcome: 'ready' | 'unavailable' | 'failed';
  durationMs: number;
  error?: SerializedDiagnostic;
}

export interface BootReport {
  generation: string;
  phase: 'ready';
  startedAt: number;
  readyAt: number;
  components: readonly ComponentBootResult[];
  degradedCapabilities: readonly CapabilityUnavailable[];
}

export interface ComponentStopResult {
  componentId: string;
  outcome: 'stopped' | 'failed' | 'timed-out';
  durationMs: number;
  error?: SerializedDiagnostic;
}

export interface ComponentVerificationResult {
  componentId: string;
  state: 'stopped' | 'live' | 'unknown';
  details?: Record<string, unknown>;
  error?: SerializedDiagnostic;
}

export interface StartupFailureReport {
  generation: string;
  phase: 'failed-start' | 'quarantined';
  startedAt: number;
  failedAt: number;
  cause: SerializedDiagnostic;
  components: readonly ComponentBootResult[];
  rollback: readonly ComponentStopResult[];
  verification: readonly ComponentVerificationResult[];
  residualResources: readonly ResourceSnapshot[];
}

export interface ShutdownReport {
  generation: string;
  phase: 'stopped' | 'failed-stop' | 'quarantined';
  requestedAt: number;
  finishedAt: number;
  reason: string;
  components: readonly ComponentStopResult[];
  verification: readonly ComponentVerificationResult[];
  residualResources: readonly ResourceSnapshot[];
}

export interface BackendSnapshot {
  generation: string;
  phase: BackendPhase;
  startedAt?: number;
  readyAt?: number;
  stoppingAt?: number;
  terminalAt?: number;
  degradedCapabilities: readonly CapabilityUnavailable[];
}

export function serializeDiagnostic(error: unknown): SerializedDiagnostic {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
}

export class BackendLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendLifecycleError';
  }
}

export class BackendStartError extends Error {
  constructor(readonly report: StartupFailureReport) {
    super(`Backend startup ended in ${report.phase}: ${report.cause.message}`);
    this.name = 'BackendStartError';
  }
}
