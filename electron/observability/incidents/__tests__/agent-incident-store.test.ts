import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentIncidentStore } from '../agent-incident-store.js';
import type {
  AgentIncident,
  AgentIncidentChange,
} from '../../../../shared/types/agent-incidents.js';

beforeEach(() => {
  agentIncidentStore.destroy();
});

describe('AgentIncidentStore changes', () => {
  it('publishes committed report, recover, and clear facts', () => {
    const changes: AgentIncidentChange[] = [];
    const unsubscribe = agentIncidentStore.changes.subscribe((change) => changes.push(change));
    const incident = agentIncidentStore.raise({
      severity: 'error',
      category: 'ai_request',
      source: { agentId: 'agent-1' },
      message: 'failed',
    });

    agentIncidentStore.recover({ agentId: 'agent-1' });
    expect(agentIncidentStore.dismiss(incident.id)).toBe(true);
    unsubscribe();

    expect(changes.map((change) => change.type)).toEqual(['added', 'updated', 'removed']);
    expect(agentIncidentStore.snapshot()).toEqual([]);
  });

  it('recovers only the exact Agent or Worker target', () => {
    const main = agentIncidentStore.raise({
      severity: 'error',
      category: 'system',
      source: { agentId: 'agent-1' },
      message: 'main failed',
    });
    const worker = agentIncidentStore.raise({
      severity: 'error',
      category: 'system',
      source: { agentId: 'agent-1', workerId: 'worker-1' },
      message: 'worker failed',
    });
    agentIncidentStore.recover({ agentId: 'agent-1', workerId: 'worker-1' });

    expect(agentIncidentStore.snapshot().find((item) => item.id === main.id)?.autoRecovered).toBe(
      false
    );
    expect(agentIncidentStore.snapshot().find((item) => item.id === worker.id)?.autoRecovered).toBe(
      true
    );
  });

  it('clears the complete AgentRun incident tree', () => {
    agentIncidentStore.raise({
      severity: 'error',
      category: 'system',
      source: { agentId: 'agent-1' },
      message: 'main failed',
    });
    agentIncidentStore.raise({
      severity: 'error',
      category: 'system',
      source: { agentId: 'agent-1', workerId: 'worker-1' },
      message: 'worker failed',
    });
    agentIncidentStore.raise({
      severity: 'error',
      category: 'system',
      source: { agentId: 'agent-2' },
      message: 'other failed',
    });

    agentIncidentStore.clearAgent('agent-1');
    expect(agentIncidentStore.snapshot().map((incident) => incident.source.agentId)).toEqual([
      'agent-2',
    ]);
  });

  it('does not let a failed observer roll back an incident mutation', () => {
    const healthy = vi.fn();
    const unsubscribeFailed = agentIncidentStore.changes.subscribe(() => {
      throw new Error('projection failed');
    });
    const unsubscribeHealthy = agentIncidentStore.changes.subscribe(healthy);

    const incident = agentIncidentStore.raise({
      severity: 'warning',
      category: 'system',
      source: { agentId: 'agent-1' },
      message: 'warning',
    });

    expect(agentIncidentStore.snapshot()).toContainEqual(incident);
    expect(healthy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'added',
        incident,
      })
    );
    unsubscribeFailed();
    unsubscribeHealthy();
  });

  it('publishes capacity evictions so a subscriber stays aligned', () => {
    const projected = new Map<string, AgentIncident>();
    const changes: AgentIncidentChange[] = [];
    const unsubscribe = agentIncidentStore.changes.subscribe((change) => {
      changes.push(change);
      if (change.type === 'added') projected.set(change.incident.id, change.incident);
      if (change.type === 'removed') projected.delete(change.incident.id);
    });

    const first = agentIncidentStore.raise({
      severity: 'warning',
      category: 'system',
      source: { agentId: 'capacity-test' },
      message: 'incident-0',
    });
    for (let index = 1; index <= 100; index += 1) {
      agentIncidentStore.raise({
        severity: 'warning',
        category: 'system',
        source: { agentId: 'capacity-test' },
        message: `incident-${index}`,
      });
    }
    unsubscribe();

    const storedIds = agentIncidentStore
      .snapshot()
      .map((incident) => incident.id)
      .sort();
    expect(storedIds).toHaveLength(100);
    expect(storedIds).not.toContain(first.id);
    expect([...projected.keys()].sort()).toEqual(storedIds);
    expect(changes.slice(-2).map((change) => change.type)).toEqual(['removed', 'added']);
  });
});
