/**
 * marker 回放语义：
 * - reasoning 快照只属于一次活跃运行，历史 marker 不跨恢复；
 * - model/approvalMode 仍由 header 恢复。
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
import type { AgentConversationContext } from '../context/agent-conversation-context.js';
import type { AgentSpec } from '../specs/spec.js';
import type { ConversationEntry } from '../../../shared/types/agent-control.js';
import type { ReasoningSelection } from '../../../shared/types/reasoning.js';
import type { AgentInferencePort } from '../../inference/application/agent-inference-port.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';

function buildRuntime(extra: {
  initialModel?: string;
  inference?: AgentInferencePort;
  validateReasoningSelection?: (model: string, sel: unknown) => boolean;
  conversationStore?: unknown;
} = {}): AgentRuntime {
  const spec = {
    name: 'director',
    role: 'director',
    modules: [],
  } as unknown as AgentSpec;
  return new AgentRuntime({
    spec,
    inference: extra.inference ?? fakeAgentInference(),
    pilotPorts: undefined,
    conversationStore: extra.conversationStore ?? {
      append: vi.fn(),
      count: vi.fn(() => 0),
      materializeMessageContent: vi.fn(async (_mainAgentId, _agentId, content) => content),
      materializeToolResultBlocks: vi.fn(async (_mainAgentId, _agentId, blocks) => blocks),
    } as never,
    onStateChange: () => {},
    options: {
      mainAgentId: 'test-agent',
      initialModel: extra.initialModel ?? 'provider-1::model-1',
      runConfig: { name: 'marker', description: '', promptTemplate: '' },
    } as never,
  });
}

function contextOf(runtime: AgentRuntime): AgentConversationContext {
  return (runtime as unknown as { context: AgentConversationContext }).context;
}

const summaryEntry = (ts: number): ConversationEntry => ({
  t: 'summary',
  ts,
  summary: { id: 'sum-1', content: '历史摘要', createdAt: ts } as never,
});

describe('marker 回放（环境强制覆盖机制已删除）', () => {
  it('原样回放当前 ATA event 产生的 subagent presentation', async () => {
    const runtime = buildRuntime();
    const presentation = [
      '<subagent_event id="worker-1" type="completed" ts="2026-08-20T00:00:00.000Z">',
      '<summary>任务完成</summary>',
      '<detail path="/tmp/agent-runs/main-1/workers/worker-1/ata-events/result.md"/>（完整内容可用 read 读取）',
      '</subagent_event>',
    ].join('\n');

    await runtime.replayConversation([{
      t: 'msg',
      ts: 1,
      id: 'current-ata-presentation',
      role: 'user',
      content: presentation,
      subtype: 'subagent_notification',
    }]);

    expect(contextOf(runtime).getAllMessages()).toContainEqual(expect.objectContaining({
      role: 'user',
      content: presentation,
      subtype: 'subagent_notification',
    }));
  });

  it('已结算的历史 MCP tool_use 按事实回放，不按恢复后的目录校验', async () => {
    const runtime = buildRuntime()
    const removedTool = 'mcp__removed__old-tool'

    await expect(runtime.replayConversation([
      {
        t: 'msg',
        ts: 1,
        id: 'assistant-old-tool',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'old-call', name: removedTool, input: {} }],
      },
      {
        t: 'tool',
        ts: 2,
        toolUseId: 'old-call',
        result: [{ type: 'text', text: 'historical success' }],
        ok: true,
      },
    ])).resolves.toBeUndefined()

    const blocks = contextOf(runtime).getAllMessages()
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'tool_use',
      id: 'old-call',
      name: removedTool,
    }))
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      tool_use_id: 'old-call',
    }))
  })

  it('隔离活跃 Flow 快照，并让新建或恢复的 Flow 读取最新配置', () => {
    let configured: ReasoningSelection = { kind: 'effort', effort: 'medium' };
    const inference = fakeAgentInference({
      resolveReasoning: (_target, override) => ({
        selection: override ?? configured,
        source: override ? 'agent' : 'model',
        nativeParameters: {},
      }),
    });
    const flowA = buildRuntime({ inference });
    const flowB = buildRuntime({ inference });

    configured = { kind: 'effort', effort: 'high' };
    flowA.setReasoningOverride(configured);

    expect(flowA.reasoningOverride).toEqual({ kind: 'effort', effort: 'high' });
    expect(flowB.reasoningOverride).toEqual({ kind: 'effort', effort: 'medium' });
    expect(buildRuntime({ inference }).reasoningOverride).toEqual({ kind: 'effort', effort: 'high' });
  });

  it('恢复时忽略历史 reasoning marker，并从最新模型配置建立明确快照', async () => {
    // 场景：模型 A（仅支持 effort）设置 reasoning → summary → 切换模型 B（仅支持 budget）→ 退出 → resume。
    // header 以最终模型 B 初始化；历史 reasoningOverride marker 不携带所属模型，
    // 若重演会在 B 上校验 A 的 effort selection 而抛错 → 整个 flow 无法 resume。
    const effortSel = { type: 'effort', effort: 'high' };
    const runtime = buildRuntime({
      initialModel: 'provider-1::model-b',
      // B 只接受 budget 型 selection：历史 effort selection 一旦被重演校验即抛错
      validateReasoningSelection: (model, sel) =>
        model === 'provider-1::model-b' ? (sel as { type: string }).type === 'budget' : true,
    });

    const entries: ConversationEntry[] = [
      { t: 'marker', ts: 1, key: 'reasoningOverride', value: effortSel },
      { t: 'marker', ts: 2, key: 'reasoningByModel', value: { model: 'provider-1::model-a', selection: effortSel } },
      summaryEntry(3),
      { t: 'marker', ts: 4, key: 'model', value: 'provider-1::model-b' },
      { t: 'marker', ts: 5, key: 'reasoningByModel', value: { model: 'provider-1::model-b', selection: null } },
    ];

    await expect(runtime.replayConversation(entries)).resolves.toBeUndefined();

    const r = runtime as unknown as {
      getModel(): string;
      reasoningOverride?: unknown;
      reasoningByModel: Map<string, unknown>;
    };
    // 当前快照来自恢复时的最新模型配置，不被历史 marker 重演污染。
    expect(r.getModel()).toBe('provider-1::model-b');
    expect(r.reasoningOverride).toEqual({ kind: 'provider-default' });
    expect(r.reasoningByModel.has('provider-1::model-a')).toBe(false);
    expect(r.reasoningByModel.get('provider-1::model-b')).toEqual({ kind: 'provider-default' });
  });

  it('resume 把有效历史中的三张 image_ref 全部恢复为运行时图片并保持顺序', async () => {
    const materializeMessageContent = vi.fn(async (_mainAgentId, _agentId, content) => {
      if (!Array.isArray(content)) return content;
      return content.map((block) => block.type === 'image_ref'
        ? {
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.mediaType,
              data: Buffer.from(block.path).toString('base64'),
            },
          }
        : block);
    });
    const runtime = buildRuntime({
      conversationStore: {
        append: vi.fn(),
        count: vi.fn(() => 0),
        materializeMessageContent,
        materializeToolResultBlocks: vi.fn(async (_mainAgentId, _agentId, blocks) => blocks),
      },
    });
    const ref = (path: string) => ({
      type: 'image_ref' as const,
      path,
      size: 1,
      mediaType: 'image/png',
    });

    await runtime.replayConversation([{
      t: 'msg',
      ts: 1,
      id: 'three-images',
      role: 'user',
      subtype: 'user_input',
      content: [ref('blobs/one.png'), { type: 'text', text: 'between' }, ref('blobs/two.png'), ref('blobs/three.png')],
    }]);

    const [message] = contextOf(runtime).getAllMessages();
    expect(Array.isArray(message?.content) ? message.content.map((block) => block.type) : []).toEqual([
      'image', 'text', 'image', 'image',
    ]);
    expect(materializeMessageContent).toHaveBeenCalledOnce();
  });
});
