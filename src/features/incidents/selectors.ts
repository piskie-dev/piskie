import type { AgentIncident, AgentTarget } from '../../../shared/types';

function isVisibleIncident(incident: AgentIncident): boolean {
  return !incident.autoRecovered
    && (incident.severity === 'warning'
      || incident.severity === 'error'
      || incident.severity === 'critical');
}

export function selectVisibleIncidents(incidents: readonly AgentIncident[]): AgentIncident[] {
  return incidents.filter(isVisibleIncident);
}

/** Returns the latest active failure for one conversation target. */
export function selectLatestTargetIncident(
  incidents: readonly AgentIncident[],
  target: AgentTarget,
): AgentIncident | undefined {
  return selectVisibleIncidents(incidents).find((incident) => (
    incident.source.agentId === target.agentId
    && incident.source.workerId === target.workerId
    && (incident.severity === 'error' || incident.severity === 'critical')
  ));
}
