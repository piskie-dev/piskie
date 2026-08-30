import { describe, expect, it, vi } from 'vitest';

import type { AgentRunHeader } from '../../../shared/types/agent-control.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import { AgentService } from '../agent.service.js';

function header(): AgentRunHeader {
  return {
    agentId: 'agent-1',
    agentSpec: 'director',
    modeId: 'normal',
    currentModel: 'provider::model',
    approvalMode: 'confirm',
    childAgents: [],
    runConfig: { name: 'Run', description: '', promptTemplate: '' },
    createdAt: '2026-08-17T00:00:00.000Z',
    lastActiveAt: '2026-08-17T00:00:00.000Z',
  } as AgentHeader;
}

describe('AgentService history activity state', () => {
  it('builds a zeroed preview from header metadata without replaying conversation metrics', () => {
    const service = new AgentService();
    const read = vi.fn(() => {
      throw new Error('history preview must not inspect conversation entries');
    });
    Object.assign(service as object, {
      conversationStore: {
        findMainAgentId: vi.fn(() => 'agent-1'),
        readHeader: vi.fn(() => header()),
        count: vi.fn(() => 37),
        read,
      },
    });

    const preview = service.buildHistoryPreview('agent-1');

    expect(preview).toMatchObject({
      agentId: 'agent-1',
      phase: 'waiting',
      conversationLength: 37,
      runMetrics: {
        rounds: 0,
        steps: 0,
        llmDurationMs: 0,
        toolDurationMs: 0,
        coverage: {
          toolTiming: 'none',
          firstVisibleContent: 'none',
          throughput: 'none',
          inputTokens: 'none',
          outputTokens: 'none',
          cacheReadTokens: 'none',
        },
      },
    });
    expect(preview?.activeStartedAt).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
