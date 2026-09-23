import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentIncident } from '../../../../../shared/types';

const harness = vi.hoisted(() => ({
  controlStates: {} as Record<string, unknown>,
}));

vi.mock('../../../../renderer-runtime/hooks', () => ({
  useDisplayAgentState: (agentId: string) => harness.controlStates[agentId],
}));

import {
  resolveConversationBrowserResources,
  resolveConversationTarget,
  projectWorkerTasks,
  resolveConversationRequest,
  resolveRequest,
  useAgentVM,
  useWorkerVM,
  type AgentVM,
  type WorkerVM,
} from '../vm';

describe('resolveRequest', () => {
  it('retains final AI failure and retry counts for in-session display', () => {
    expect(resolveRequest({
      requestId: 'request-1',
      phase: 'finished',
      outcome: 'failed',
      attempt: 3,
      maxAttempts: 3,
      errorCode: 'invalid_prompt',
      errorMessage: 'provider body',
    })).toEqual({
      retrying: false,
      failed: true,
      backoff: false,
      attempt: 3,
      maxAttempts: 3,
      retryAt: undefined,
      attemptStartedAt: undefined,
      errorCode: 'invalid_prompt',
      errorMessage: 'provider body',
    });
  });

  it('keeps successful and initial requests silent', () => {
    expect(resolveRequest({
      requestId: 'request-1', phase: 'requesting', attempt: 0, maxAttempts: 3,
    })).toBeUndefined();
    expect(resolveRequest({
      requestId: 'request-1', phase: 'finished', outcome: 'success', attempt: 1, maxAttempts: 3,
    })).toBeUndefined();
  });

  it('keeps the active incident visible while a later request replaces the transient failure', () => {
    const incident: AgentIncident = {
      id: 'incident-1',
      timestamp: new Date('2026-08-25T13:27:34.512Z'),
      severity: 'error',
      category: 'ai_request',
      source: { agentId: 'agent-1' },
      message: 'OpenAI Responses stream ended without a terminal event',
      details: { code: 'network' },
      autoRecovered: false,
    };

    expect(resolveConversationRequest({
      requestId: 'request-next',
      phase: 'requesting',
      attempt: 0,
      maxAttempts: 0,
    }, incident)).toMatchObject({
      failed: true,
      errorMessage: incident.message,
      errorCode: 'network',
    });
  });

  it('projects compaction recovery as dedicated activity instead of retrying', () => {
    expect(resolveRequest({
      requestId: 'request-1', phase: 'compacting', attempt: 1, maxAttempts: 5,
    })).toMatchObject({
      retrying: false,
      failed: false,
      backoff: false,
      activity: 'compacting',
    });
    expect(resolveRequest({
      requestId: 'request-1', phase: 'resending', attempt: 1, maxAttempts: 5,
    })).toMatchObject({ activity: 'resending', retrying: false });
  });

  it('projects the Worker approval mode instead of inheriting the parent display value', () => {
    const workerMetrics = { rounds: 1, steps: 2 };
    harness.controlStates = {
      main: {
        runMetrics: { rounds: 99, steps: 99 },
        runConfig: { workspace: '/workspace/sample-main' },
        children: [{
          id: 'worker',
          subject: 'Worker',
          workspace: '/workspace/sample-worker',
          type: 'local-worker',
          phase: 'waiting',
          currentModel: 'provider::model',
          approvalMode: 'confirm',
          conversationLength: 0,
          runMetrics: workerMetrics,

          browserReady: false,
        }],
      },
    };
    let projected: WorkerVM | null = null;
    function Probe() {
      projected = useWorkerVM('main', 'worker');
      return null;
    }

    renderToStaticMarkup(createElement(Probe));

    expect(projected).toMatchObject({
      id: 'worker',
      workspace: '/workspace/sample-worker',
      approvalMode: 'confirm',
      runMetrics: workerMetrics,
    });
  });
});

describe('reasoning snapshots', () => {
  it('projects each main and Worker value independently when the current target changes', () => {
    const medium = { kind: 'effort', effort: 'medium' } as const;
    const low = { kind: 'effort', effort: 'low' } as const;
    const high = { kind: 'effort', effort: 'high' } as const;
    const main = {
      agentId: 'session-example', phase: 'waiting', currentModel: 'provider::model',
      runConfig: { name: 'Example session' }, reasoningOverride: medium,
      children: [{
        id: 'worker-example', phase: 'waiting', currentModel: 'provider::model',
        reasoningOverride: low,
      }],
    };
    const other = { ...main, agentId: 'session-other', children: [] };
    harness.controlStates = { 'session-example': main, 'session-other': other };
    let projected: Array<AgentVM | WorkerVM | null> = [];
    function Probe() {
      projected = [useAgentVM('session-example'), useWorkerVM('session-example', 'worker-example'), useAgentVM('session-other')];
      return null;
    }
    const selections = () => projected.map((target) => target?.reasoningOverride);

    renderToStaticMarkup(createElement(Probe));
    expect(selections()).toEqual([medium, low, medium]);

    harness.controlStates['session-example'] = { ...main, reasoningOverride: high };
    renderToStaticMarkup(createElement(Probe));
    expect(selections()).toEqual([high, low, medium]);

    harness.controlStates['session-example'] = {
      ...main, reasoningOverride: high,
      children: [{ ...main.children[0], reasoningOverride: medium }],
    };
    renderToStaticMarkup(createElement(Probe));
    expect(selections()).toEqual([high, medium, medium]);
  });
});

describe('Worker task projection', () => {
  it('shows Main’s latest owner matches, including completed and newly recorded work', () => {
    const make = (id: string, owner: string | null, status: 'pending' | 'completed' = 'pending') => ({
      id, owner, status, subject: 'Sample task', description: 'Sample scope', dependsOn: [],
    });
    const board = { taskSummary: 'Sample board', items: [
      make('main-work', 'main-a'), make('unassigned', null), make('other-work', 'worker-b'),
      make('open', 'worker-a'), make('done', 'worker-a', 'completed'),
    ] };
    expect(projectWorkerTasks(board, 'worker-a')).toEqual(board.items.slice(3));
    expect(projectWorkerTasks(undefined, 'worker-a')).toEqual([]);
    expect(projectWorkerTasks(board, 'worker-missing')).toEqual([]);
    const updated = { ...board, items: [make('open', 'worker-b'), make('new-work', 'worker-a')] };
    expect(projectWorkerTasks(updated, 'worker-a')).toEqual([updated.items[1]]);
    expect(board.items).toHaveLength(5);
  });
});

describe('conversation browser resources', () => {
  it('projects the session set and each Worker binding from the control state', () => {
    harness.controlStates['session-example'] = {
      agentId: 'session-example', phase: 'waiting', currentModel: 'provider::model',
      runConfig: { name: 'Example session' }, browserEnvironmentIds: ['environment-a', 'environment-b'],
      children: [
        { id: 'worker-browser', phase: 'running', currentModel: 'provider::model', type: 'browser-worker',
          subject: 'Sample browsing', browserId: 'environment-environment-a', browserEnvironmentId: 'environment-a' },
        { id: 'worker-temporary', phase: 'running', currentModel: 'provider::model', type: 'browser-worker',
          subject: 'Sample scouting', browserId: 'worker-temporary' },
        { id: 'worker-local', phase: 'running', currentModel: 'provider::model', type: 'local-worker', subject: 'Sample files' },
      ],
    };
    let agent: AgentVM | null = null;
    const workers: Record<string, WorkerVM | null> = {};
    function Probe() {
      agent = useAgentVM('session-example');
      workers['worker-browser'] = useWorkerVM('session-example', 'worker-browser');
      workers['worker-temporary'] = useWorkerVM('session-example', 'worker-temporary');
      workers['worker-local'] = useWorkerVM('session-example', 'worker-local');
      return null;
    }
    renderToStaticMarkup(createElement(Probe));

    expect(agent!.browserEnvironmentIds).toEqual(['environment-a', 'environment-b']);
    expect(resolveConversationBrowserResources(agent, null, undefined)).toEqual({
      kind: 'session', environmentIds: ['environment-a', 'environment-b'], workers: agent!.workers,
    });
    expect(resolveConversationBrowserResources(agent, workers['worker-browser'] ?? null, 'worker-browser'))
      .toEqual({ kind: 'worker', environmentId: 'environment-a' });
    expect(resolveConversationBrowserResources(agent, workers['worker-temporary'] ?? null, 'worker-temporary'))
      .toEqual({ kind: 'worker', environmentId: undefined });
    expect(resolveConversationBrowserResources(agent, workers['worker-local'] ?? null, 'worker-local')).toBeUndefined();
    expect(resolveConversationBrowserResources(null, null, undefined)).toBeUndefined();
  });

  it('falls back to an empty session set when the control state predates the field', () => {
    harness.controlStates['session-legacy'] = {
      agentId: 'session-legacy', phase: 'waiting', currentModel: 'provider::model', runConfig: { name: 'Legacy' }, children: [],
    };
    let agent: AgentVM | null = null;
    function Probe() { agent = useAgentVM('session-legacy'); return null; }
    renderToStaticMarkup(createElement(Probe));
    expect(agent!.browserEnvironmentIds).toEqual([]);
  });
});

describe('resolveConversationTarget', () => {
  it('never substitutes main data for a requested Worker that is not available', () => {
    const main = { agentId: 'main' } as AgentVM;
    const worker = { id: 'worker' } as WorkerVM;

    expect(resolveConversationTarget(main, worker, undefined)).toBe(main);
    expect(resolveConversationTarget(main, worker, 'worker')).toBe(worker);
    expect(resolveConversationTarget(main, null, 'worker')).toBeNull();
  });
});
