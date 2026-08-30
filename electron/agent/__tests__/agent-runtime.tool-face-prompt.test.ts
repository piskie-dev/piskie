/**
 * 工具面与提示词的一致性（AgentSpec -> AgentRuntime -> mergedCustomTools -> assembled prompt）。
 *
 * 曾经的缺陷：AgentRuntime 给所有 director 角色隐式注入编排工具，导致 Spec、
 * exposed schema 和 assembled prompt 不一致。
 * 现在工具面唯一来源 = spec.customTools，canManageAgentRuns 从同一来源派生——
 * 本测试用真实 builtin spec 验证派生链端到端一致，防回归。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test', on: () => undefined },
}));

vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/tmp/piskie-test/workspace',
    getTempDir: () => '/tmp/piskie-test/tmp',
  },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));

import { AgentRuntime } from '../agent-runtime.js';
import type { AgentSpec } from '../specs/spec.js';
import { directorSpec } from '../specs/builtin/director.js';
import { systemChatSpec } from '../specs/builtin/system-chat.js';
import { localWorkerSpec } from '../specs/builtin/local-worker.js';
import { ToolCatalog, type FinalToolFace } from '../../tools/catalog.js';
import { AgentRunTool } from '../../tools/agent/agent-run.tool.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';

const noAgentRunDirectorSpec: AgentSpec = {
  ...directorSpec,
  name: 'director-no-agent-run',
  tools: {
    ...directorSpec.tools,
    customTools: directorSpec.tools.customTools.filter((name) => name !== 'agent_run'),
  },
};

function buildRuntime(spec: AgentSpec, subagentConfig?: Record<string, unknown>): AgentRuntime {
  const runtime = new AgentRuntime({
    id: 'director-1',
    // modules 置空：本测试只验证工具面/提示词派生链，不实例化模块
    spec: { ...spec, modules: [] },
    inference: fakeAgentInference(),
    pilotPorts: undefined,
    conversationStore: { append: vi.fn(), count: vi.fn(() => 0) } as never,
    onStateChange: () => {},
    options: {
      mainAgentId: 'director-1',
      runConfig: { name: 'face', description: 'face', promptTemplate: 'face' },
      initialModeId: 'normal',
      initialApprovalMode: 'confirm',
      initialModel: 'provider-1::model-1',
      subagentConfig,
    } as never,
  });
  const merged = [...new Set([...spec.tools.customTools])].filter(
    (name) => !(spec.tools.exclude ?? []).includes(name)
  );
  const catalog = new ToolCatalog();
  catalog.register(new AgentRunTool(), 'builtin');
  const internal = runtime as unknown as {
    toolCatalog: ToolCatalog;
    toolFace: FinalToolFace;
  };
  internal.toolCatalog = catalog;
  internal.toolFace = {
    scope: spec.role === 'worker' ? 'subagent' : 'main',
    agentType: spec.role === 'worker' ? 'subagent' : 'main',
    customTools: merged,
    exposedSkillFunctions: [],
    excluded: new Set(spec.tools.exclude ?? []),
    domains: new Set(['local']),
  };
  return runtime;
}

/** spec → runtime → 工具面与提示词，三方一致性断言 */
function assertConsistent(spec: AgentSpec): void {
  const runtime = buildRuntime(spec) as unknown as {
    mergedCustomTools(): string[];
    buildPromptContext(): { canManageAgentRuns: boolean };
    createToolContext(): { allowedCustomTools?: readonly string[] };
  };
  const merged = runtime.mergedCustomTools();
  const declaredAgentRun = spec.tools.customTools.includes('agent_run');

  // ① 无隐式注入：最终工具面恰好来自 Spec 声明。
  expect(merged.includes('agent_run')).toBe(declaredAgentRun);

  // ①b 真实暴露门：Catalog snapshot 的 definitions 与 resolve 使用同一 FinalToolFace。
  expect(runtime.getAvailableTools().some((tool) => tool.name === 'agent_run'))
    .toBe(declaredAgentRun);

  // ② 提示词上下文与工具面同源
  const ctx = runtime.buildPromptContext();
  expect(ctx.canManageAgentRuns).toBe(declaredAgentRun);

  // ③ assembled prompt 的管理动作指引在场性 == 工具在场性
  const prompt = spec.buildSystemPrompt(ctx as never);
  expect(prompt.includes('需要创建或管理其他顶层智能体时，使用对应工具'))
    .toBe(declaredAgentRun);
}

describe('工具面 ↔ 提示词一致性（真实 builtin spec 全链路）', () => {
  it('start always enters the existing mailbox loop after prepare', async () => {
    const runtime = buildRuntime(directorSpec);
    const prepare = vi.spyOn(runtime, 'prepare').mockResolvedValue();
    const internal = runtime as unknown as { postSystemEvent(type: 'start'): void };
    const postSystemEvent = vi.spyOn(internal, 'postSystemEvent').mockImplementation(() => {});

    await runtime.start();

    expect(prepare).toHaveBeenCalledOnce();
    expect(postSystemEvent).toHaveBeenCalledWith('start');
  });

  it('director：有 agent_run → 提示词含顶层智能体管理措辞', () => {
    expect(directorSpec.tools.customTools).toContain('agent_run');
    assertConsistent(directorSpec);
  });

  it('system-chat：有 agent_run → 一致', () => {
    expect(systemChatSpec.tools.customTools).toContain('agent_run');
    assertConsistent(systemChatSpec);
  });

  it('无 agent_run director：工具面和提示词都不声明顶层智能体管理', () => {
    expect(noAgentRunDirectorSpec.tools.customTools).not.toContain('agent_run');
    assertConsistent(noAgentRunDirectorSpec);
  });

  it('spec.exclude 剔除 agent_run：提示词与白名单同步', () => {
    const excludedSpec: AgentSpec = {
      ...directorSpec,
      name: 'director-agent-run-excluded',
      tools: {
        ...directorSpec.tools,
        exclude: [...(directorSpec.tools.exclude ?? []), 'agent_run'],
      },
    };
    const runtime = buildRuntime(excludedSpec) as unknown as {
      mergedCustomTools(): string[];
      buildPromptContext(): { canManageAgentRuns: boolean };
    };
    expect(runtime.mergedCustomTools()).not.toContain('agent_run');
    const ctx = runtime.buildPromptContext();
    expect(ctx.canManageAgentRuns).toBe(false);
    expect(excludedSpec.buildSystemPrompt(ctx as never)).not.toContain(
      '需要创建或管理其他顶层智能体时，使用对应工具'
    );
  });

  it('Worker 的 Spec 不含 agent_run，因此 canManageAgentRuns 为 false', () => {
    const runtime = buildRuntime(localWorkerSpec, { mode: 'local' }) as unknown as {
      buildPromptContext(): { canManageAgentRuns: boolean };
    };
    expect(runtime.buildPromptContext().canManageAgentRuns).toBe(false);
  });
});
