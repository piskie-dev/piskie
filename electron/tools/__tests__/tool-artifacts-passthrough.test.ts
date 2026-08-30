/**
 * 通用结算链对 artifacts 只做透传：
 * toToolResult 保持模型面纯净（不含 data/artifacts）；Coordinator 对任意
 * synthetic artifact 原样透传（用非 edit 工具证明不依赖工具名）；observation
 * 仍收到诊断 data；PendingSettlement 的 terminal release 规则不因 artifacts 改变。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import type { Settler } from '../../agent/conversation/settler.js';
import { ToolCallContextFactory, type ToolActivationContext } from '../../agent/tool-call/context-builder.js';
import { PendingSettlement } from '../../agent/tool-call/pending-settlement.js';
import type { ToolArtifact } from '../../../shared/types/index.js';
import { ToolCatalog, type FinalToolFace } from '../catalog.js';
import { ToolCoordinator } from '../coordinator.js';
import { z } from '../params.js';
import { toToolResult, type ITool, type ToolOutput, type ToolResult } from '../types.js';

const SYNTHETIC_ARTIFACT: ToolArtifact = {
  kind: 'file_diff',
  payload: {
    path: '/workspace/demo.txt',
    unifiedDiff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
    stat: { linesAdded: 0, linesDeleted: 0, linesChanged: 1 },
  },
};

const FACE: FinalToolFace = {
  scope: 'subagent',
  agentType: 'worker',
  customTools: ['artifact_probe'],
  exposedSkillFunctions: [],
  excluded: new Set(),
  domains: new Set(['local']),
};

function activation(): ToolActivationContext {
  return {
    agentType: 'worker',
    agentSpec: 'local-worker',
    agentId: 'agent-1',
    mainAgentId: 'main-1',
    runConfig: { name: 'run', description: '', promptTemplate: '' },
    resourceIds: {},
    currentModel: () => 'provider::model',
    workspace: { dir: '/workspace', tempDir: '/tmp/agent-1' },
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
    post: () => true,
  };
}

/** 非 edit 的探针工具：证明透传链没有任何按工具名的分支。 */
function probeTool(output: ToolOutput<unknown>): ITool<Record<string, never>, unknown> {
  return {
    def: {
      name: 'artifact_probe',
      description: 'artifact passthrough probe',
      schema: z.object({}),
      scope: 'shared',
      effects: [],
    },
    execute: async () => output,
  };
}

async function runProbe(output: ToolOutput<unknown>): Promise<{
  pending: PendingSettlement;
  observer: { start: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> };
}> {
  const catalog = new ToolCatalog();
  catalog.register(probeTool(output), 'builtin');
  const observer = { start: vi.fn(), finish: vi.fn() };
  const coordinator = new ToolCoordinator({
    contexts: new ToolCallContextFactory({
      activation: activation(),
      signal: () => new AbortController().signal,
    }),
    observer,
  });
  const run = await coordinator.run(
    { modelName: 'artifact_probe', rawParams: {}, callId: 'call-1' },
    catalog.snapshot(FACE),
  );
  expect(run).toBeInstanceOf(PendingSettlement);
  return { pending: run as PendingSettlement, observer };
}

describe('通用透传链', () => {
  it('toToolResult 输出不含 data/artifacts', () => {
    const ok = toToolResult({
      ok: true,
      text: '完成',
      data: { diagnostic: 1 },
      artifacts: [SYNTHETIC_ARTIFACT],
    });
    expect(ok).toEqual({ ok: true, text: '完成' });
    expect('data' in ok).toBe(false);
    expect('artifacts' in ok).toBe(false);

    const failed = toToolResult({
      ok: false,
      text: '失败',
      images: [{ base64: 'ZmFpbHVyZQ==', mediaType: 'image/png' }],
      artifacts: [SYNTHETIC_ARTIFACT],
    });
    expect(failed).toEqual({
      ok: false,
      text: '失败',
      images: [{ base64: 'ZmFpbHVyZQ==', mediaType: 'image/png' }],
    });
    expect('artifacts' in failed).toBe(false);
  });

  it('Coordinator 对任意 synthetic artifact 原样透传，不依赖工具名', async () => {
    const { pending } = await runProbe({
      ok: true,
      text: '探针完成',
      data: { diagnostic: 'observer-only' },
      artifacts: [SYNTHETIC_ARTIFACT],
    });

    expect(pending.artifacts).toEqual([SYNTHETIC_ARTIFACT]);
    expect(pending.result).toEqual({ ok: true, text: '探针完成' });
    expect('artifacts' in pending.result).toBe(false);
    expect('data' in pending.result).toBe(false);
  });

  it('observation 仍收到诊断 data，但 result 不含 artifacts', async () => {
    const { observer } = await runProbe({
      ok: true,
      text: '探针完成',
      data: { diagnostic: 'observer-only' },
      artifacts: [SYNTHETIC_ARTIFACT],
    });

    expect(observer.finish).toHaveBeenCalledTimes(1);
    const observation = observer.finish.mock.calls[0][0] as {
      outcome: string;
      data: unknown;
      result: ToolResult;
    };
    expect(observation.outcome).toBe('ok');
    expect(observation.data).toEqual({ diagnostic: 'observer-only' });
    expect('artifacts' in observation.result).toBe(false);
  });

  it('无 artifacts 的工具输出透传后 pending.artifacts 缺省', async () => {
    const { pending } = await runProbe({ ok: true, text: '无产物' });
    expect(pending.artifacts).toBeUndefined();
  });

  it('PendingSettlement.commit 转交 artifacts，terminal release 规则不变', () => {
    const settleLive = vi.fn().mockReturnValue('inserted');
    const settler = { settleLive } as unknown as Settler;

    const pending = new PendingSettlement(
      'call-1',
      'artifact_probe',
      { ok: true, text: '完成' },
      undefined,
      [SYNTHETIC_ARTIFACT],
    );
    expect(pending.commit(settler)).toEqual({ settled: 'inserted', terminal: undefined });
    expect(settleLive).toHaveBeenCalledWith({
      kind: 'tool',
      callId: 'call-1',
      toolName: 'artifact_probe',
      result: { ok: true, text: '完成' },
      artifacts: [SYNTHETIC_ARTIFACT],
    });

    // 带 terminal + ok + inserted → 释放；带 artifacts 不改变该规则
    const terminal = new PendingSettlement(
      'call-2',
      'artifact_probe',
      { ok: true, text: '完成' },
      'completed',
      [SYNTHETIC_ARTIFACT],
    );
    expect(terminal.commit(settler)).toEqual({ settled: 'inserted', terminal: 'completed' });

    // 未 inserted → 不释放 terminal，artifacts 依旧只是随行数据
    settleLive.mockReturnValue('already_settled');
    const blocked = new PendingSettlement(
      'call-3',
      'artifact_probe',
      { ok: true, text: '完成' },
      'completed',
      [SYNTHETIC_ARTIFACT],
    );
    expect(blocked.commit(settler)).toEqual({ settled: 'already_settled' });
  });
});
