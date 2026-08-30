import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
  hasAgentInMemory: vi.fn(),
  scanHeaders: vi.fn(),
  listTraces: vi.fn(),
}));

vi.mock('../../../services/agent.service.js', () => ({
  agentService: {
    startAgent: h.startAgent,
    stopAgent: h.stopAgent,
    hasAgentInMemory: h.hasAgentInMemory,
    getConversationStore: () => ({ scanHeaders: h.scanHeaders }),
  },
}));
vi.mock('../../../agent-runs/agent-run-trace-service.js', () => ({
  agentRunTraceService: {
    tracePath: (agentId: string) => `/tmp/${agentId}/trace.md`,
    list: h.listTraces,
  },
}));

import { AgentRunTool } from '../agent-run.tool.js';

const context = (modeId = 'normal') => ({
  agentType: 'main',
  agentSpec: 'director',
  agentId: 'main-1',
  mainAgentId: 'main-1',
  currentModel: 'provider-a::model-x',
  modes: {
    approvalMode: () => 'auto',
    modeId: () => modeId,
  },
  runConfig: {
    name: 'origin',
    description: 'origin',
    promptTemplate: 'origin',
    workspace: '/tmp/workspace',
    bindings: { type: 'standard', boundEnvironmentIds: ['browser-1'] },
  },
}) as never;

beforeEach(() => {
  h.startAgent.mockReset();
  h.stopAgent.mockReset();
  h.hasAgentInMemory.mockReset();
  h.scanHeaders.mockReset();
  h.listTraces.mockReset();
});

describe('AgentRunTool', () => {
  it('把独立顶层任务与当前任务分工区分清楚', () => {
    const description = new AgentRunTool().def.description;

    expect(description).toContain('用户明确要求启动另一套独立的顶层任务');
    expect(description).toContain('当前任务内的分工或并行加速使用 subagent');
    expect(description).toContain('刚走进房间的聪明同事');
    expect(description).toContain('不向当前会话汇报');
    expect(description).toContain('发起停止');
    expect(description).not.toContain('账号');
    expect(description).not.toContain('继承你的模型');
  });

  it('creates a one-off Director AgentRun and inherits execution defaults', async () => {
    h.startAgent.mockResolvedValue({ agentId: 'new-agent' });

    const result = await new AgentRunTool().execute({
      action: 'create',
      taskDescription: '独立整理一份竞品报告',
    }, context());

    expect(result.ok).toBe(true);
    expect(h.startAgent).toHaveBeenCalledWith({
      runConfig: {
        name: '独立整理一份竞品报告',
        description: '独立整理一份竞品报告',
        promptTemplate: '独立整理一份竞品报告',
        workspace: '/tmp/workspace',
        bindings: { type: 'standard', boundEnvironmentIds: ['browser-1'] },
      },
      agentSpec: expect.objectContaining({ name: 'director' }),
      initialModeId: 'normal',
      initialApprovalMode: 'auto',
      launchOptions: { initialModel: 'provider-a::model-x' },
    });
    expect(result.data).toMatchObject({
      agentId: 'new-agent',
      tracePath: '/tmp/new-agent/trace.md',
    });
  });

  it.each([
    ['plan', 'plan'],
    ['browser-skill', 'normal'],
  ])('maps parent mode %s to initial mode %s', async (parentMode, expectedMode) => {
    h.startAgent.mockResolvedValue({ agentId: 'new-agent' });

    const result = await new AgentRunTool().execute({
      action: 'create',
      taskDescription: '独立任务',
    }, context(parentMode));

    expect(result.ok).toBe(true);
    expect(h.startAgent).toHaveBeenCalledWith(expect.objectContaining({
      initialModeId: expectedMode,
    }));
  });

  it('rejects self-stop and starts asynchronous stop for another active AgentRun', async () => {
    const tool = new AgentRunTool();
    const self = await tool.execute({ action: 'stop', agentId: 'main-1' }, context());
    expect(self.ok).toBe(false);
    expect(h.stopAgent).not.toHaveBeenCalled();

    h.hasAgentInMemory.mockReturnValue(true);
    h.stopAgent.mockReturnValue(new Promise(() => {}));
    const stopped = await tool.execute({ action: 'stop', agentId: 'main-2' }, context());
    expect(stopped.ok).toBe(true);
    expect(h.stopAgent).toHaveBeenCalledWith('main-2');
  });

  it('lists disk-backed AgentRuns and marks status from in-memory runtimes', async () => {
    h.listTraces.mockResolvedValue([
      { agentId: 'main-a', recentTail: 'A latest step', tracePath: '/a' },
    ]);
    h.scanHeaders.mockReturnValue([
      header('main-b', 'Run B', '2026-08-18T00:00:00.000Z'),
      header('main-a', 'Run A', '2026-08-19T00:00:00.000Z'),
    ]);
    h.hasAgentInMemory.mockImplementation((id: string) => id === 'main-a');

    const result = await new AgentRunTool().execute({ action: 'list' }, context());

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ runs: [
      expect.objectContaining({
        agentId: 'main-a',
        status: 'active',
        recentTail: 'A latest step',
      }),
      expect.objectContaining({
        agentId: 'main-b',
        status: 'stopped',
        recentTail: '',
      }),
    ] });
  });
});

function header(agentId: string, name: string, lastActiveAt: string) {
  return {
    agentId,
    agentSpec: 'director',
    modeId: 'normal',
    runConfig: { name, description: name, promptTemplate: name },
    createdAt: lastActiveAt,
    lastActiveAt,
    currentModel: 'provider::model',
    approvalMode: 'confirm',
    childAgents: [],
  };
}
