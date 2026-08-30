import { describe, expect, it } from 'vitest';
import type { AgentControlSnapshot } from '@shared/electron-contracts/agent-runs';
import type { ChildControlState } from '@shared/types/agent-control';
import { createAgentControlStore } from '../agent-control-store';

function child(id: string, phase: ChildControlState['phase'] = 'waiting'): ChildControlState {
  return { id, phase } as ChildControlState;
}

function agent(
  agentId: string,
  options: {
    phase?: AgentControlSnapshot['phase'];
    name?: string;
    children?: ChildControlState[];
    interrupted?: boolean;
    pending?: boolean;
    contextTokens?: number;
  } = {},
): AgentControlSnapshot {
  return {
    agentId,
    phase: options.phase ?? 'waiting',
    children: options.children ?? [],
    runConfig: { name: options.name ?? agentId },
    ...(options.interrupted !== undefined && { interrupted: options.interrupted }),
    ...(options.pending && { pendingQuestion: { id: 'question' } }),
    ...(options.contextTokens !== undefined && {
      contextUsage: { tokens: options.contextTokens, limit: 100 },
    }),
  } as AgentControlSnapshot;
}

describe('agentControlStore', () => {
  it('indexes agents and children without scanning the agent tree', () => {
    const store = createAgentControlStore();
    store.replace({ main: agent('main', { children: [child('worker')] }) });

    expect(store.resolve('main')).toMatchObject({ kind: 'agent', mainAgentId: 'main' });
    expect(store.resolve('worker')).toMatchObject({ kind: 'child', mainAgentId: 'main' });

    store.apply({ agentId: 'main', state: agent('main') });
    expect(store.resolve('worker')).toBeUndefined();
  });

  it('projects header counters and task names once per control update', () => {
    const store = createAgentControlStore();
    store.replace({
      first: agent('first', { name: ' First task ', pending: true }),
      busy: agent('busy', { phase: 'thinking', name: 'Busy task' }),
    });

    const header = store.state.getState().header;
    expect(header).toMatchObject({
      activeCount: 2,
      busyCount: 2,
      approvalCount: 1,
      status: 'running',
      defaultTaskName: 'First task',
    });
    expect(header.taskNamesByAgentId).toMatchObject({ busy: 'Busy task', first: 'First task' });
  });

  it('keeps the header reference stable when only non-header control data changes', () => {
    const store = createAgentControlStore();
    store.replace({ main: agent('main', { contextTokens: 10 }) });
    const header = store.state.getState().header;

    store.apply({ agentId: 'main', state: agent('main', { contextTokens: 20 }) });

    expect(store.state.getState().header).toBe(header);
  });

  it('projects idle when no agents are loaded', () => {
    const store = createAgentControlStore();

    expect(store.state.getState().header.status).toBe('idle');
  });

  it('projects an ordinary waiting agent as running', () => {
    const store = createAgentControlStore();
    store.replace({ main: agent('main') });

    expect(store.state.getState().header.status).toBe('running');
  });

  it('keeps running when interrupted and ordinary waiting agents coexist', () => {
    const store = createAgentControlStore();
    store.replace({
      interrupted: agent('interrupted', { interrupted: true }),
      waiting: agent('waiting'),
    });

    expect(store.state.getState().header.status).toBe('running');
  });

  it('projects interrupted when every agent is interrupted and no child is working', () => {
    const store = createAgentControlStore();
    store.replace({
      first: agent('first', { interrupted: true }),
      second: agent('second', { interrupted: true }),
    });

    expect(store.state.getState().header.status).toBe('interrupted');
  });

  it('keeps running when a child resumes under an interrupted agent', () => {
    const store = createAgentControlStore();
    store.replace({
      main: agent('main', {
        interrupted: true,
        children: [child('worker', 'executing')],
      }),
    });

    expect(store.state.getState().header.status).toBe('running');
  });
});
