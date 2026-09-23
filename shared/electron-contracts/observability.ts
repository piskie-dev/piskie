import type {
  AgentIncident,
  AgentIncidentChange,
  AppSettings,
  SystemLogFileSummary,
  SystemLogQuery,
  LogQueryResponse,
  Occupancy,
} from '../types/index.js';
import type { UsageCleanupPreview, UsageFilter, UsagePage, UsageRecord, UsageReport, UsageSort, UsageStorageStatus } from '../types/model-usage.js';

export const OBSERVABILITY_OPERATIONS = Object.freeze({
  usageQuery: 'observability.usage.query',
  usagePage: 'observability.usage.page',
  usageDetail: 'observability.usage.detail',
  usageStatus: 'observability.usage.status',
  usageExport: 'observability.usage.export',
  usagePreview: 'observability.usage.previewCleanup',
  usageCleanup: 'observability.usage.cleanup',
  clearIncident: 'observability.incidents.clear',
  clearIncidents: 'observability.incidents.clearAll',
  querySystemLogs: 'observability.systemLogs.query',
  systemLogFiles: 'observability.systemLogs.files',
  exportSystemLogs: 'observability.systemLogs.export',
  listOccupancy: 'observability.occupancy.list',
  recordClientLog: 'observability.clientLogs.record',
} as const);

export const OBSERVABILITY_TOPICS = Object.freeze({
  incidents: 'observability.incidents.changes',
  occupancy: 'observability.occupancy.changes',
} as const);

interface IncidentsClient {
  clear(incidentId: string): Promise<void>;
  clearAll(): Promise<void>;
  observe(observer: {
    onSnapshot(incidents: AgentIncident[]): void;
    onChange(event: AgentIncidentChange): void;
  }): () => void;
}

interface SystemLogsClient {
  query(filter?: SystemLogQuery): Promise<LogQueryResponse>;
  files(): Promise<SystemLogFileSummary[]>;
  export(filter: SystemLogQuery, suggestedName: string): Promise<{
    exportedCount: number;
    fileName: string;
  }>;
}

interface OccupancyClient {
  list(): Promise<Occupancy[]>;
  observe(listener: (occupancies: Occupancy[]) => void): () => void;
}

export interface ClientLogInput {
  event: 'config.domain.refresh.failed';
  context: { domain: string };
}

interface ClientLogsClient {
  record(input: ClientLogInput): Promise<void>;
}

export interface ObservabilityClient {
  readonly modelUsage: {
    query(filter: UsageFilter): Promise<UsageReport>;
    page(snapshotId: string, offset: number, sort: UsageSort, descending: boolean): Promise<UsagePage>;
    detail(snapshotId: string, id: string): Promise<{ record: UsageRecord; related: UsageRecord[] }>;
    status(): Promise<UsageStorageStatus>;
    /** Returns null when the user cancels the save dialog. */
    export(snapshotId: string, language: AppSettings['language']): Promise<{ exportedCount: number; fileName: string } | null>;
    previewCleanup(days: number | null, all: boolean): Promise<UsageCleanupPreview>;
    cleanup(all: boolean, confirmed: boolean): Promise<UsageCleanupPreview>;
  };
  readonly incidents: IncidentsClient;
  readonly systemLogs: SystemLogsClient;
  readonly occupancy: OccupancyClient;
  readonly clientLogs: ClientLogsClient;
}
