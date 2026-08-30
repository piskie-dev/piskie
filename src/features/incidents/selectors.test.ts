import { describe, expect, it } from 'vitest';
import type { AgentIncident } from '../../../shared/types';
import { selectLatestTargetIncident, selectVisibleIncidents } from './selectors';

function incident(overrides: Partial<AgentIncident> = {}): AgentIncident {
  return {
    id: 'incident-1',
    timestamp: new Date('2026-08-25T13:27:34.512Z'),
    severity: 'error',
    category: 'ai_request',
    source: { agentId: 'agent-1' },
    message: 'stream ended early',
    autoRecovered: false,
    ...overrides,
  };
}

describe('incident selectors', () => {
  it('hides a recovered incident from both the global indicator and its conversation status', () => {
    const recovered = incident({ autoRecovered: true });

    expect(selectVisibleIncidents([recovered])).toEqual([]);
    expect(selectLatestTargetIncident([recovered], { agentId: 'agent-1' })).toBeUndefined();
  });

  it('does not leak a Worker incident into its parent conversation', () => {
    const workerFailure = incident({ source: { agentId: 'agent-1', workerId: 'worker-1' } });

    expect(selectLatestTargetIncident([workerFailure], { agentId: 'agent-1' })).toBeUndefined();
    expect(selectLatestTargetIncident(
      [workerFailure],
      { agentId: 'agent-1', workerId: 'worker-1' },
    )).toBe(workerFailure);
  });
});
