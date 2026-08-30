import type { AgentTarget } from './agent-control.js';

export type IncidentSeverity = 'info' | 'warning' | 'error' | 'critical';

export type IncidentCategory =
  | 'ai_request'
  | 'browser'
  | 'network'
  | 'tool_execution'
  | 'system';

/** A terminal, user-visible problem associated with one Agent runtime. */
export interface AgentIncident {
  id: string;
  timestamp: Date;
  severity: IncidentSeverity;
  category: IncidentCategory;
  source: AgentTarget;
  message: string;
  details?: {
    originalError?: string;
    code?: string;
    context?: Record<string, unknown>;
  };
  suggestions?: string[];
  autoRecovered?: boolean;
  recoveredAt?: Date;
}

export interface ReportAgentIncidentInput {
  severity: IncidentSeverity;
  category: IncidentCategory;
  source: AgentTarget;
  message?: string;
  code?: string;
  originalError?: string;
  context?: Record<string, unknown>;
}

export type AgentIncidentChange =
  | { type: 'added' | 'updated' | 'removed'; incident: AgentIncident }
  | { type: 'cleared'; incidents: AgentIncident[] };
