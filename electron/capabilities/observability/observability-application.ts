import path from 'node:path';
import type { OccupancyRegistry } from '../../core/occupancy/registry.js';
import type { DesktopPresentationPort } from '../../desktop/desktop-presentation-port.js';
import type { AgentIncidentStore } from '../../observability/incidents/agent-incident-store.js';
import type { FileLogStore } from '../../observability/logging/file-log-store.js';
import type { SystemLogQuery } from '../../../shared/types/index.js';
import type { ClientLogInput } from '../../../shared/electron-contracts/observability.js';
import { appLog } from '../../observability/logging/app-log.js';
import { PublicOperationError } from '../public-errors.js';

export class ObservabilityApplication {
  private readonly clientLogWindows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly dependencies: {
      incidents: AgentIncidentStore;
      systemLogs: FileLogStore;
      occupancy: OccupancyRegistry;
      presentation: DesktopPresentationPort;
    }
  ) {}

  clearIncident(incidentId: string): void {
    if (!this.dependencies.incidents.dismiss(incidentId)) {
      throw new PublicOperationError('not-found', 'Agent incident was not found');
    }
  }

  clearIncidents(): void {
    this.dependencies.incidents.clearAll();
  }

  incidentSnapshot() {
    return this.dependencies.incidents.snapshot();
  }

  async querySystemLogs(filter?: SystemLogQuery) {
    return this.dependencies.systemLogs.queryLogs(filter);
  }

  async systemLogFiles() {
    return this.dependencies.systemLogs.getLogFiles();
  }

  async exportSystemLogs(
    windowId: number,
    filter: SystemLogQuery,
    suggestedName: string
  ): Promise<{ exportedCount: number; fileName: string }> {
    const filePath = await this.dependencies.presentation.chooseSavePath(windowId, {
      title: 'Export logs',
      suggestedName,
      extensions: ['json'],
    });
    if (!filePath) throw new PublicOperationError('aborted', 'Log export was cancelled');
    const exportedCount = await this.dependencies.systemLogs.exportLogs(filter, filePath);
    if (exportedCount === undefined) {
      throw new PublicOperationError('unavailable', 'Logs could not be exported');
    }
    return { exportedCount, fileName: path.basename(filePath) };
  }

  listOccupancy() {
    return this.dependencies.occupancy.list();
  }

  recordClientLog(connectionId: string, windowId: number, input: ClientLogInput): void {
    if (!this.takeClientLogPermit(connectionId)) return;
    appLog.error({
      event: 'config.domain.refresh.failed',
      message: 'Configuration domain refresh failed',
      context: {
        scope: 'config.domain',
        domain: input.context.domain,
        connectionId,
        windowId,
      },
    });
  }

  releaseConnection(connectionId: string): void {
    this.clientLogWindows.delete(connectionId);
  }

  observeIncidents(
    listener: Parameters<AgentIncidentStore['changes']['subscribe']>[0],
    signal: AbortSignal
  ): () => void {
    return this.dependencies.incidents.changes.subscribe(listener, { signal });
  }

  occupancyChanges() {
    return this.dependencies.occupancy.changes;
  }

  private takeClientLogPermit(connectionId: string): boolean {
    const now = Date.now();
    const current = this.clientLogWindows.get(connectionId);
    if (!current || now - current.startedAt >= 60_000) {
      this.clientLogWindows.set(connectionId, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= 10) return false;
    current.count += 1;
    return true;
  }
}
