import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import { ToolCallContextFactory, type ToolActivationContext } from '../../agent/tool-call/context-builder.js';
import { PendingSettlement } from '../../agent/tool-call/pending-settlement.js';
import { ToolCatalog, type CatalogEntry, type FinalToolFace } from '../catalog.js';
import { ToolCoordinator } from '../coordinator.js';
import { z } from '../params.js';

function activation(approvalMode: 'auto' | 'confirm' = 'auto'): ToolActivationContext {
  return {
    agentType: 'main',
    agentSpec: 'director',
    agentId: 'agent-1',
    mainAgentId: 'main-1',
    runConfig: { name: 'run', description: '', promptTemplate: '' },
    resourceIds: {},
    currentModel: () => 'provider::model',
    workspace: { dir: '/workspace', tempDir: '/tmp/agent-1' },
    modes: { modeId: () => 'normal', approvalMode: () => approvalMode },
    post: () => true,
  };
}

function deferredMcpEntry(
  visibleName: string,
  executed: string[],
): CatalogEntry {
  return Object.freeze({
    modelName: visibleName,
    tool: {
      def: {
        name: visibleName,
        description: 'remote tool',
        schema: z.looseObject({}),
        scope: 'shared' as const,
        effects: ['external'],
      },
      async execute() {
        executed.push(visibleName);
        return { ok: true as const, text: 'remote ok' };
      },
    },
    trust: 'custom' as const,
    identity: {
      kind: 'mcp' as const,
      server: 'srv',
      tool: 'remote-tool',
      transport: 'stdio' as const,
      origin: 'global-explicit' as const,
    },
    exposure: 'deferred' as const,
    definitionOverride: {
      name: visibleName,
      description: 'remote tool',
      input_schema: { type: 'object' as const, properties: {} },
    },
  });
}

function setup(executed: string[]) {
  const face: FinalToolFace = {
    scope: 'main',
    agentType: 'main',
    customTools: [],
    exposedSkillFunctions: [],
    excluded: new Set(),
    domains: new Set(['local']),
  };
  const snapshot = new ToolCatalog().snapshot(face, {
    entries: [deferredMcpEntry('mcp__srv__remote-tool', executed)],
  });
  const coordinator = new ToolCoordinator({
    contexts: new ToolCallContextFactory({
      activation: activation(),
      signal: () => new AbortController().signal,
    }),
    observer: { start: vi.fn(), finish: vi.fn() },
  });
  return { snapshot, coordinator };
}

describe('ToolCoordinator × deferred MCP 工具', () => {
  it('未装载即调用 → 拒绝并指向 tool_search，不执行工具', async () => {
    const executed: string[] = [];
    const { snapshot, coordinator } = setup(executed);

    const outcome = await coordinator.run(
      { modelName: 'mcp__srv__remote-tool', rawParams: {}, callId: 'c1' },
      snapshot,
      new Set(),
    );

    expect(outcome).toBeInstanceOf(PendingSettlement);
    const pending = outcome as PendingSettlement;
    expect(pending.result.ok).toBe(false);
    expect(pending.result.text).toContain('tool_search("select:mcp__srv__remote-tool")');
    expect(executed).toEqual([]);
  });

  it('装载后调用直达执行', async () => {
    const executed: string[] = [];
    const { snapshot, coordinator } = setup(executed);

    const outcome = await coordinator.run(
      { modelName: 'mcp__srv__remote-tool', rawParams: { q: 'x' }, callId: 'c2' },
      snapshot,
      new Set(['mcp__srv__remote-tool']),
    );

    const pending = outcome as PendingSettlement;
    expect(pending.result).toMatchObject({ ok: true, text: 'remote ok' });
    expect(executed).toEqual(['mcp__srv__remote-tool']);
  });

  it('恢复后新调用已移除的工具名，走 unknownTool 明确拒绝', async () => {
    const { snapshot, coordinator } = setup([]);
    const outcome = await coordinator.run(
      { modelName: 'mcp__srv__nope', rawParams: {}, callId: 'c3' },
      snapshot,
      new Set(),
    );
    const pending = outcome as PendingSettlement;
    expect(pending.result.ok).toBe(false);
    expect(pending.result.text).toContain('没有名为 mcp__srv__nope 的工具');
  });

  it('Auto 对 MCP 与其他工具一致生效，不进入审批端口', async () => {
    const executed: string[] = [];
    const request = vi.fn(async ({ call }: { call: { callId: string } }) => ({
      callId: call.callId,
      decision: 'allow' as const,
    }));
    const face: FinalToolFace = {
      scope: 'main',
      agentType: 'main',
      customTools: [],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
    };
    const snapshot = new ToolCatalog().snapshot(face, {
      entries: [deferredMcpEntry('mcp__srv__remote-tool', executed)],
    });
    const coordinator = new ToolCoordinator({
      contexts: new ToolCallContextFactory({
        activation: activation(),
        signal: () => new AbortController().signal,
      }),
      observer: { start: vi.fn(), finish: vi.fn() },
      pipeline: { approval: { request } },
    });

    await coordinator.run(
      { modelName: 'mcp__srv__remote-tool', rawParams: {}, callId: 'auto-mcp' },
      snapshot,
      new Set(['mcp__srv__remote-tool']),
    );

    expect(request).not.toHaveBeenCalled();
    expect(executed).toEqual(['mcp__srv__remote-tool']);
  });

  it('Confirm 下 MCP 使用通用审批端口，且允许切换当前 Agent 到 Auto', async () => {
    const executed: string[] = [];
    const request = vi.fn(async ({ call }: {
      call: { callId: string };
      modeInvariant: boolean;
    }) => ({
      callId: call.callId,
      decision: 'allow' as const,
      changeToAuto: true,
    }));
    const face: FinalToolFace = {
      scope: 'main',
      agentType: 'main',
      customTools: [],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
    };
    const snapshot = new ToolCatalog().snapshot(face, {
      entries: [deferredMcpEntry('mcp__srv__remote-tool', executed)],
    });
    const coordinator = new ToolCoordinator({
      contexts: new ToolCallContextFactory({
        activation: activation('confirm'),
        signal: () => new AbortController().signal,
      }),
      observer: { start: vi.fn(), finish: vi.fn() },
      pipeline: { approval: { request } },
    });

    await coordinator.run(
      { modelName: 'mcp__srv__remote-tool', rawParams: {}, callId: 'confirm-mcp' },
      snapshot,
      new Set(['mcp__srv__remote-tool']),
    );

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toMatchObject({ modeInvariant: false });
    expect(executed).toEqual(['mcp__srv__remote-tool']);
  });
});
