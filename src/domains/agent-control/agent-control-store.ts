import { createStore, type StoreApi } from 'zustand/vanilla';
import { canPause, isInterrupted } from '@shared/types/agent-control';
import type {
  AgentControlChangedEvent,
  AgentControlSnapshot,
} from '@shared/electron-contracts/agent-runs';

type ChildControlSnapshot = AgentControlSnapshot['children'][number];

export type AgentControlTarget =
  | {
      readonly kind: 'agent';
      readonly mainAgentId: string;
      readonly state: AgentControlSnapshot;
    }
  | {
      readonly kind: 'child';
      readonly mainAgentId: string;
      readonly state: ChildControlSnapshot;
    };

export interface AgentHeaderProjection {
  readonly activeCount: number;
  readonly busyCount: number;
  readonly approvalCount: number;
  readonly status: 'running' | 'interrupted' | 'idle';
  readonly taskNamesByAgentId: Readonly<Record<string, string | null>>;
  readonly defaultTaskName: string | null;
}

export interface AgentControlStoreSnapshot {
  readonly agentsById: Readonly<Record<string, AgentControlSnapshot>>;
  readonly targetsById: Readonly<Record<string, AgentControlTarget>>;
  readonly header: AgentHeaderProjection;
}

export interface AgentControlStore {
  readonly state: StoreApi<AgentControlStoreSnapshot>;
  replace(states: Readonly<Record<string, AgentControlSnapshot>>): void;
  apply(event: AgentControlChangedEvent): void;
  clear(): void;
  resolve(targetId: string): AgentControlTarget | undefined;
}

const EMPTY_HEADER: AgentHeaderProjection = Object.freeze({
  activeCount: 0,
  busyCount: 0,
  approvalCount: 0,
  status: 'idle',
  taskNamesByAgentId: Object.freeze({}),
  defaultTaskName: null,
});

const EMPTY_SNAPSHOT: AgentControlStoreSnapshot = Object.freeze({
  agentsById: Object.freeze({}),
  targetsById: Object.freeze({}),
  header: EMPTY_HEADER,
});

export function createAgentControlStore(): AgentControlStore {
  const state = createStore<AgentControlStoreSnapshot>(() => EMPTY_SNAPSHOT);

  const publish = (agentsById: Readonly<Record<string, AgentControlSnapshot>>) => {
    const previous = state.getState();
    state.setState({
      agentsById,
      targetsById: indexTargets(agentsById),
      header: projectHeader(agentsById, previous.header),
    });
  };

  return {
    state,
    replace(states) {
      publish({ ...states });
    },
    apply({ agentId, state: nextState }) {
      const current = state.getState().agentsById;
      if (nextState === null && current[agentId] === undefined) return;
      if (nextState !== null && current[agentId] === nextState) return;

      const next = { ...current };
      if (nextState === null) delete next[agentId];
      else next[agentId] = nextState;
      publish(next);
    },
    clear() {
      if (Object.keys(state.getState().agentsById).length === 0) return;
      state.setState(EMPTY_SNAPSHOT, true);
    },
    resolve(targetId) {
      return state.getState().targetsById[targetId];
    },
  };
}

function indexTargets(
  agentsById: Readonly<Record<string, AgentControlSnapshot>>,
): Readonly<Record<string, AgentControlTarget>> {
  const targets: Record<string, AgentControlTarget> = {};
  for (const agent of Object.values(agentsById)) {
    targets[agent.agentId] = {
      kind: 'agent',
      mainAgentId: agent.agentId,
      state: agent,
    };
    for (const child of agent.children) {
      targets[child.id] = {
        kind: 'child',
        mainAgentId: agent.agentId,
        state: child,
      };
    }
  }
  return targets;
}

function projectHeader(
  agentsById: Readonly<Record<string, AgentControlSnapshot>>,
  previous: AgentHeaderProjection,
): AgentHeaderProjection {
  const agents = Object.values(agentsById);
  let approvalCount = 0;
  const taskNamesByAgentId: Record<string, string | null> = {};

  for (const agent of agents) {
    if (agent.pendingToolCall || agent.pendingQuestion) approvalCount += 1;
    approvalCount += agent.children.filter((child) => child.pendingToolCall).length;
    taskNamesByAgentId[agent.agentId] = normalizeTaskName(agent.runConfig.name);
  }

  const next: AgentHeaderProjection = {
    activeCount: agents.length,
    busyCount: agents.filter(canPause).length,
    approvalCount,
    status: projectHeaderStatus(agents),
    taskNamesByAgentId,
    defaultTaskName: agents[0]
      ? taskNamesByAgentId[agents[0].agentId] ?? null
      : null,
  };
  return sameHeader(previous, next) ? previous : next;
}

function projectHeaderStatus(
  agents: ReadonlyArray<AgentControlSnapshot>,
): AgentHeaderProjection['status'] {
  if (agents.length === 0) return 'idle';

  // A child may resume independently while its main agent remains interrupted.
  if (agents.some(canPause)) return 'running';

  return agents.every(isInterrupted) ? 'interrupted' : 'running';
}

function normalizeTaskName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sameHeader(left: AgentHeaderProjection, right: AgentHeaderProjection): boolean {
  return left.activeCount === right.activeCount
    && left.busyCount === right.busyCount
    && left.approvalCount === right.approvalCount
    && left.status === right.status
    && left.defaultTaskName === right.defaultTaskName
    && sameStringRecord(left.taskNamesByAgentId, right.taskNamesByAgentId);
}

function sameStringRecord(
  left: Readonly<Record<string, string | null>>,
  right: Readonly<Record<string, string | null>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}
