import { settleWithDeadline } from './deadline.js';
import { serializeDiagnostic, type SerializedDiagnostic } from './runtime-state.js';

export type ResourceInspection = 'live' | 'closed' | 'unknown';

type ResourceKind =
  | 'browser-window'
  | 'change-subscription'
  | 'child-process'
  | 'file-lock'
  | 'file-watcher'
  | 'message-port'
  | 'server'
  | 'socket'
  | 'stream'
  | 'temporary-directory'
  | 'timer'
  | 'custom';

export interface ResourceDefinition {
  kind: ResourceKind;
  label: string;
  close(reason: string): Promise<void> | void;
  inspect(): Promise<ResourceInspection> | ResourceInspection;
  describe?(): Record<string, unknown>;
}

export interface ResourceSnapshot {
  id: string;
  generation: string;
  owner: string;
  kind: ResourceKind;
  label: string;
  acquiredAt: number;
  inspection: ResourceInspection;
  details: Record<string, unknown>;
}

export interface ResourceCloseResult {
  id: string;
  outcome: 'closed' | 'failed' | 'timed-out' | 'still-live' | 'unknown';
  error?: SerializedDiagnostic;
}

interface ResourceEntry extends ResourceDefinition {
  id: string;
  generation: string;
  owner: string;
  acquiredAt: number;
}

export interface ResourceHandle {
  readonly id: string;
  close(reason: string, timeoutMs?: number): Promise<ResourceCloseResult>;
  inspect(): Promise<ResourceInspection>;
}

export class ResourceLedger {
  private readonly entries = new Map<string, ResourceEntry>();
  private nextId = 0;

  constructor(readonly generation: string) {}

  register(owner: string, definition: ResourceDefinition): ResourceHandle {
    const id = `${this.generation}:${++this.nextId}`;
    this.entries.set(id, {
      ...definition,
      id,
      generation: this.generation,
      owner,
      acquiredAt: Date.now(),
    });

    return {
      id,
      close: (reason, timeoutMs) => this.close(id, reason, timeoutMs),
      inspect: () => this.inspect(id),
    };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  async inspect(id: string): Promise<ResourceInspection> {
    const entry = this.entries.get(id);
    if (!entry) return 'closed';
    try {
      const inspection = await entry.inspect();
      if (inspection === 'closed') this.entries.delete(id);
      return inspection;
    } catch {
      return 'unknown';
    }
  }

  async close(id: string, reason: string, timeoutMs = 5_000): Promise<ResourceCloseResult> {
    const entry = this.entries.get(id);
    if (!entry) return { id, outcome: 'closed' };

    const closeResult = await settleWithDeadline(() => entry.close(reason), timeoutMs);
    const inspection = await this.inspect(id);
    if (inspection === 'closed') {
      if (closeResult.outcome === 'settled') return { id, outcome: 'closed' };
      return {
        id,
        outcome: closeResult.outcome === 'timed-out' ? 'timed-out' : 'failed',
        error: closeResult.outcome === 'failed'
          ? serializeDiagnostic(closeResult.error)
          : undefined,
      };
    }
    if (closeResult.outcome === 'timed-out') return { id, outcome: 'timed-out' };
    if (closeResult.outcome === 'failed') {
      return { id, outcome: 'failed', error: serializeDiagnostic(closeResult.error) };
    }
    return { id, outcome: inspection === 'live' ? 'still-live' : 'unknown' };
  }

  async closeMany(
    ids: readonly string[],
    reason: string,
    timeoutMs = 5_000,
  ): Promise<readonly ResourceCloseResult[]> {
    const results: ResourceCloseResult[] = [];
    for (const id of [...ids].reverse()) {
      results.push(await this.close(id, reason, timeoutMs));
    }
    return results;
  }

  async closeAll(reason: string, timeoutMs = 5_000): Promise<readonly ResourceCloseResult[]> {
    return this.closeMany([...this.entries.keys()], reason, timeoutMs);
  }

  async snapshots(ids?: readonly string[]): Promise<readonly ResourceSnapshot[]> {
    const selected = ids
      ? ids.map((id) => this.entries.get(id)).filter((entry): entry is ResourceEntry => Boolean(entry))
      : [...this.entries.values()];
    const snapshots: ResourceSnapshot[] = [];

    for (const entry of selected) {
      let inspection: ResourceInspection;
      try {
        inspection = await entry.inspect();
      } catch {
        inspection = 'unknown';
      }
      if (inspection === 'closed') {
        this.entries.delete(entry.id);
        continue;
      }
      let details: Record<string, unknown> = {};
      try {
        details = entry.describe?.() ?? {};
      } catch (error) {
        details = { describeError: serializeDiagnostic(error) };
      }
      snapshots.push({
        id: entry.id,
        generation: entry.generation,
        owner: entry.owner,
        kind: entry.kind,
        label: entry.label,
        acquiredAt: entry.acquiredAt,
        inspection,
        details,
      });
    }
    return snapshots;
  }

  async assertEmpty(): Promise<{ empty: boolean; residuals: readonly ResourceSnapshot[] }> {
    const residuals = await this.snapshots();
    return { empty: residuals.length === 0, residuals };
  }
}
