import type {
  AgentIncident,
  AgentIncidentChange,
  SystemLogFileSummary,
  SystemLogQuery,
  LogQueryResponse,
  Occupancy,
} from '../types/index.js';

export const OBSERVABILITY_OPERATIONS = Object.freeze({
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
  readonly incidents: IncidentsClient;
  readonly systemLogs: SystemLogsClient;
  readonly occupancy: OccupancyClient;
  readonly clientLogs: ClientLogsClient;
}
