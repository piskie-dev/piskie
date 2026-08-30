import { describe, expect, it } from 'vitest';

import type {
  AgentControlSnapshot,
  AgentRunSnapshot,
} from '../../../../../shared/electron-contracts/agent-runs';
import {
  projectActiveAgentRun,
  projectPersistedAgentRun,
} from '../agentRunViewModel';

describe('AgentRun Renderer projection', () => {
  it('produces the same rows from the same snapshots without mutating either source', () => {
    const persisted = runSnapshot();
    const active = controlSnapshot();
    const persistedBefore = structuredClone(persisted);
    const activeBefore = structuredClone(active);

    expect(projectPersistedAgentRun(persisted, active))
      .toEqual(projectPersistedAgentRun(persisted, active));
    expect(projectActiveAgentRun(active, '未命名任务'))
      .toEqual(projectActiveAgentRun(active, '未命名任务'));
    expect(persisted).toEqual(persistedBefore);
    expect(active).toEqual(activeBefore);
  });

  it('uses active control only for the running display flag of a persisted history row', () => {
    const persisted = runSnapshot();
    const active = controlSnapshot({
      runConfig: {
        name: 'Transient live title',
        description: 'Transient live description',
        promptTemplate: 'Transient live prompt',
        workspace: '/live-workspace',
      },
    });

    expect(projectPersistedAgentRun(persisted, active)).toEqual({
      agentId: 'main-1',
      title: 'Persisted title',
      description: 'Persisted description',
      agentSpec: 'browser-skill-director',
      taskDescription: 'Persisted description',
      workspace: '/persisted-workspace',
      lastActiveAt: '2026-08-19T01:00:00.000Z',
      running: true,
    });
    expect(projectPersistedAgentRun(persisted, controlSnapshot({ agentId: 'other' })).running)
      .toBe(false);
  });
});

function runSnapshot(): AgentRunSnapshot {
  return {
    agentId: 'main-1',
    agentSpec: 'browser-skill-director',
    modeId: 'browser-skill',
    approvalMode: 'confirm',
    runConfig: {
      name: 'Persisted title',
      description: 'Persisted description',
      promptTemplate: 'Persisted prompt',
      workspace: '/persisted-workspace',
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    lastActiveAt: '2026-08-19T01:00:00.000Z',
    currentModel: 'provider::model',
    childAgents: [],
  };
}

function controlSnapshot(
  overrides: Partial<AgentControlSnapshot> = {},
): AgentControlSnapshot {
  return {
    agentId: 'main-1',
    phase: 'thinking',
    currentModel: 'provider::model',
    reasoningOverride: { kind: 'provider-default' },
    approvalMode: 'confirm',
    modeId: 'browser-skill',
    conversationLength: 3,
    children: [],
    pendingEvents: [],
    agentSpec: 'browser-skill-director',
    runConfig: {
      name: 'Persisted title',
      description: 'Persisted description',
      promptTemplate: 'Persisted prompt',
      workspace: '/persisted-workspace',
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    runMetrics: emptyMetrics(),
    ...overrides,
  };
}

function emptyMetrics(): AgentControlSnapshot['runMetrics'] {
  return {
    version: 1,
    rounds: 0,
    steps: 0,
    llmDurationMs: 0,
    toolDurationMs: 0,
    firstVisibleContentLatencyTotalMs: 0,
    firstVisibleContentSamples: 0,
    generationDurationMs: 0,
    generationOutputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    coverage: {
      toolTiming: 'none',
      firstVisibleContent: 'none',
      throughput: 'none',
      inputTokens: 'none',
      outputTokens: 'none',
      cacheReadTokens: 'none',
    },
  };
}
