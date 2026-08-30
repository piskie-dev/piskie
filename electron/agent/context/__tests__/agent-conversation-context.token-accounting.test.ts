/**
 * Token 计量与请求前准入。
 *
 * 锁住的是「上下文大小只认 provider 的测量」这条不变量的可观察后果：
 * 没量过就说不知道、换模型即作废、一级准入不产生任何网络请求、
 * 二级准入才向 provider 要真值——以及全仓没有一个数是本地算出来的。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));


import { AgentConversationContext } from '../agent-conversation-context.js';
import { fakeAgentInference } from '../../../testing/fake-agent-inference.js';
import type { AgentInferencePort } from '../../../inference/application/agent-inference-port.js';
import type { AIRequestInfo } from '../../../../shared/types/context.js';
import { MAX_TOOL_RESULT_BYTES } from '../../../../shared/constants/token.js';
import type { Tool } from '../../../../shared/types/index.js';

const LIMIT = 200_000;
const TARGET = { providerId: 'p', modelId: 'm' };
const OTHER_TARGET = { providerId: 'p', modelId: 'other' };
const REQUEST_SHAPE = {
  systemPrompt: 'sys',
  tools: [],
  model: TARGET,
  promptCacheKey: 'agent-t',
};

function makeManager(overrides: Partial<AgentInferencePort> = {}) {
  const inference = fakeAgentInference({ contextWindow: () => LIMIT, ...overrides });
  const manager = new AgentConversationContext({
    inference,
    target: TARGET,
    mainAgentId: 'agent-t',
  });
  return { manager, inference };
}

const requestInfo = (over: Partial<AIRequestInfo> = {}): AIRequestInfo => ({
  version: 1,
  requestId: 'turn-1',
  runId: 'run-1',
  model: 'p::m',
  usage: { inputTokens: 1000, outputTokens: 100 },
  latencyMs: 1,
  stopReason: 'end_turn',
  ...over,
});

function finishTurn(manager: AgentConversationContext, over: Partial<AIRequestInfo> = {}): void {
  const requestId = over.requestId ?? 'turn-1';
  const boundary = manager.captureRequestBoundary();
  manager.commitSuccessfulRequest(boundary, requestInfo({ ...over, requestId }));
}

describe('上下文用量：一个数，一个来源', () => {
  it('首轮请求前：没量过就是没量过，limit 恒有值', () => {
    const { manager } = makeManager();
    expect(manager.getContextUsage()).toEqual({ limit: LIMIT });
  });

  it('响应回来后：tokens = 该轮归一化 totalInputTokens，percentage 同源', () => {
    const { manager } = makeManager();
    manager.addUserMessage('hi');
    finishTurn(manager, { usage: { inputTokens: 50_000 } });

    expect(manager.getContextUsage()).toEqual({
      tokens: 50_000,
      limit: LIMIT,
      percentage: 25,
    });
  });

  it('响应后再追加消息（未再请求）：tokens 不变——这是已知行为，不是 bug', () => {
    const { manager } = makeManager();
    finishTurn(manager, { usage: { inputTokens: 50_000 } });
    manager.addUserMessage('x'.repeat(10_000));

    expect(manager.getContextUsage().tokens).toBe(50_000);
  });

  it('换模型即换尺子：旧读数作废，不折算', () => {
    const { manager } = makeManager();
    finishTurn(manager, { usage: { inputTokens: 50_000 } });

    manager.setTarget(OTHER_TARGET);
    expect(manager.getContextUsage()).toEqual({ limit: LIMIT });
  });
});

describe('两级准入', () => {
  it('普通一轮：走一级，不产生任何额外网络请求', async () => {
    const countInputTokens = vi.fn(async () => 1);
    const { manager } = makeManager({ countInputTokens });
    finishTurn(manager, { usage: { inputTokens: 1000 } });
    manager.addUserMessage('一句普通的话');

    await manager.getMessagesForAI(REQUEST_SHAPE);
    expect(countInputTokens).not.toHaveBeenCalled();
  });

  it('锚点缺失（首轮 / 刚切模型）：一级答不上来，强制向 provider 复核', async () => {
    const countInputTokens = vi.fn(async () => 1000);
    const { manager } = makeManager({ countInputTokens });
    manager.addUserMessage('hi');

    await manager.getMessagesForAI(REQUEST_SHAPE);
    expect(countInputTokens).toHaveBeenCalledTimes(1);
    // 复核结果本身就是一次 provider 测量，直接进锚点
    expect(manager.getContextUsage().tokens).toBe(1000);
  });

  it('贴入大块内容：字符上界顶破阈值 ⇒ 落二级', async () => {
    const countInputTokens = vi.fn(async () => 1000);
    const { manager } = makeManager({ countInputTokens });
    finishTurn(manager, { usage: { inputTokens: 1000 } });
    manager.addUserMessage('x'.repeat(LIMIT));

    await manager.getMessagesForAI(REQUEST_SHAPE);
    expect(countInputTokens).toHaveBeenCalledTimes(1);
  });

  it('图片按单张上限计入上界，不因 base64 字符数被误判进二级', async () => {
    const countInputTokens = vi.fn(async () => 1000);
    const { manager } = makeManager({ countInputTokens });
    finishTurn(manager, { usage: { inputTokens: 1000 } });
    // 同等字符量的纯文本会顶破阈值（见上一条），图片不会
    manager.addUserMessage([{
      type: 'image',
      source: { type: 'base64', data: 'A'.repeat(LIMIT), media_type: 'image/png' },
    }]);

    await manager.getMessagesForAI(REQUEST_SHAPE);
    expect(countInputTokens).not.toHaveBeenCalled();
  });

  it('provider 不肯提前说：直接发出去让服务端判，不退回本地估算', async () => {
    const countInputTokens = vi.fn(async () => undefined);
    const { manager } = makeManager({ countInputTokens });
    manager.addUserMessage('hi');

    await expect(manager.getMessagesForAI(REQUEST_SHAPE))
      .resolves.toBeDefined();
    expect(manager.getContextUsage().tokens).toBeUndefined();
  });

  it('countTokens 调用失败：如实说「还不知道」，不阻断请求', async () => {
    const countInputTokens = vi.fn(async () => { throw new Error('network down'); });
    const { manager } = makeManager({ countInputTokens });
    manager.addUserMessage('hi');

    await expect(manager.getMessagesForAI(REQUEST_SHAPE))
      .resolves.toBeDefined();
    expect(manager.getContextUsage().tokens).toBeUndefined();
  });
});

describe('切模型时立即重算', () => {
  it('有可作废的测量 ⇒ 重算并刷新，界面不经过「—」', async () => {
    const countInputTokens = vi.fn(async () => 77_000);
    const onMeasured = vi.fn();
    const { manager } = makeManager({ countInputTokens });
    manager.setMeasurementHook(onMeasured);

    await manager.getMessagesForAI(REQUEST_SHAPE);
    finishTurn(manager, { usage: { inputTokens: 50_000 } });
    countInputTokens.mockClear();

    manager.setTarget(OTHER_TARGET);
    await vi.waitFor(() => expect(onMeasured).toHaveBeenCalled());
    expect(manager.getContextUsage().tokens).toBe(77_000);
  });

  it('没有可作废的测量（新建子代理的 setModel）⇒ 不发这次请求', () => {
    const countInputTokens = vi.fn(async () => 1);
    const { manager } = makeManager({ countInputTokens });

    manager.setTarget(OTHER_TARGET);
    expect(countInputTokens).not.toHaveBeenCalled();
  });
});

describe('tool_result 字节配额', () => {
  it('未超配额原样返回', () => {
    const { manager } = makeManager();
    const blocks = [{ type: 'text' as const, text: 'small' }];
    expect(manager.prepareToolResultBlocks(blocks)).toEqual(blocks);
  });

  it('超配额按字节截断，提示文案给字节数', () => {
    const { manager } = makeManager();
    const [block] = manager.prepareToolResultBlocks([
      { type: 'text', text: 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1000) },
    ]);

    expect(block.text).toContain('结果已截断');
    expect(block.text).toContain('字节');
    expect(block.text).not.toContain('tokens');
  });
});

describe('结构化上下文按需拉取', () => {
  it('保留模型边界结构，并带上同源的精确总量', () => {
    const { manager } = makeManager();
    manager.addUserMessage('hello');
    finishTurn(manager, { usage: { inputTokens: 42 } });

    const snapshot = manager.buildContextSnapshot('SYSTEM', []);
    expect(snapshot.systemPrompt).toBe('SYSTEM');
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.messages).toContainEqual({
      role: 'user',
      content: 'hello',
      subtype: 'user_input',
    });
    expect(snapshot.usage.tokens).toBe(42);
  });

  it('只从首个带 provider usage 的新请求开始投影 token 检查点', () => {
    const { manager } = makeManager();
    manager.addAssistantMessage('restored response');
    manager.addUserMessage('new request');
    const boundary = manager.captureRequestBoundary();
    const measured = requestInfo({
      requestId: 'measured-request',
      usage: { inputTokens: 12_345, outputTokens: 20 },
    });
    manager.commitSuccessfulRequest(boundary, measured);
    manager.addAssistantMessage('measured response', measured);

    const snapshot = manager.buildContextSnapshot('SYSTEM', []);
    expect(snapshot.requestTokenCheckpoints).toEqual([
      { messageIndex: 2, inputTokens: 12_345 },
    ]);
  });

  it('压缩判定与 UI 读取同一个计量值，避免口径再次分裂', () => {
    const { manager } = makeManager();
    finishTurn(manager, { usage: { inputTokens: 12_345 } });

    expect(manager.buildContextSnapshot('s', []).usage)
      .toEqual(manager.getContextUsage());
  });

  it('工具定义与 call/result 身份不经文本投影而原样保留', () => {
    const { manager } = makeManager();
    manager.addAssistantMessage([{
      type: 'tool_use',
      id: 'skill-1',
      name: 'skill_call',
      input: { skill: 'example-site', function: 'searchOptions', args: { query: 'x' } },
    }], 'request-skill-1');
    manager.appendToolResultProjection(
      'skill-1',
      [{ type: 'text', text: '{"ok":true}' }],
      true,
      Date.now(),
    );
    const tools: Tool[] = [
      { name: 'skill_call', description: 'Call a Skill.', input_schema: { type: 'object', properties: {} } },
      { name: 'read', description: 'Read a file.', input_schema: { type: 'object', properties: {} } },
    ];

    const snapshot = manager.buildContextSnapshot('SYSTEM', tools);
    expect(snapshot.tools).toEqual(tools);
    const [callMessage, resultMessage] = snapshot.messages;
    expect(callMessage).toMatchObject({ role: 'assistant' });
    expect(Array.isArray(callMessage?.content) ? callMessage.content[0] : null).toMatchObject({
      type: 'tool_use',
      id: 'skill-1',
      name: 'skill_call',
      input: expect.objectContaining({
        skill: 'example-site',
        function: 'searchOptions',
      }),
    });
    expect(resultMessage).toMatchObject({ role: 'user' });
    expect(Array.isArray(resultMessage?.content) ? resultMessage.content[0] : null).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'skill-1',
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
  });
});
