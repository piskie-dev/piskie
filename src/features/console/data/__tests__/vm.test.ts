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
  resolveConversationTarget,
  resolveConversationRequest,
  resolveRequest,
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
        children: [{
          id: 'worker',
          subject: 'Worker',
          mode: 'local',
          phase: 'waiting',
          currentModel: 'provider::model',
          approvalMode: 'confirm',
          conversationLength: 0,
          runMetrics: workerMetrics,
          taskIds: [],
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
      approvalMode: 'confirm',
      runMetrics: workerMetrics,
    });
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
