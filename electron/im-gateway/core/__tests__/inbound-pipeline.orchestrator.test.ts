import { createUuid } from '@shared/utils/identifiers.js';
/**
 * InboundPipeline 编排器
 *
 * 覆盖：命令分流（kind='direct'）、sender/配置/媒体直接拒绝、
 * ensure→setDispatcher→inject→waitForNextYield 顺序、五条 Agent 运输出口
 * 的单次 queue 收尾、inject false/抛错的对象身份 CAS 清理、
 * 核心层不串行化并发消息、媒体 finally 清理。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';



vi.mock('../agent-launch.js', () => {
  class ImTaskDefinitionUnavailableError extends Error {
    constructor(definitionId?: string) {
      super(definitionId
        ? `Task Definition 不存在: ${definitionId}`
        : 'IM Bot 尚未绑定 Task Definition');
      this.name = 'ImTaskDefinitionUnavailableError';
    }
  }
  return {
    ImTaskDefinitionUnavailableError,
    resolveImAgentLaunch: vi.fn(),
  };
});

import { InboundPipeline, TASK_DEFINITION_MISSING_REPLY } from '../inbound-pipeline.js';
import { ReplyInterceptor } from '../../reply-interceptor.js';
import { IMCommandRouter } from '../../commands/command-router.js';
import { resolveImAgentLaunch, ImTaskDefinitionUnavailableError } from '../agent-launch.js';
import { getManagedMediaDir, UNSUPPORTED_MEDIA_REPLY } from '../inbound-media.js';
import { SENDER_REJECT_REPLY } from '../sender-envelope.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';
import type { InboundMessage } from '../channel-connector.js';
import type { IMCommandHandler } from '../../commands/command-types.js';

const AGENT_LAUNCH = {
  conversation: { botId: 'bot-1', peerKind: 'direct', peerId: 'peer-1' },
  launch: {
    runConfig: {
      name: 'T · B · 私聊 peer-1',
      description: '',
      promptTemplate: '完成任务',
    },
    agentSpec: { name: 'director' },
    initialModeId: 'normal',
    initialApprovalMode: 'confirm',
  },
} as const;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bot(overrides: Partial<MessagingConnectionConfig> = {}): MessagingConnectionConfig {
  return {
    id: 'bot-1',
    name: 'B',
    channelType: 'wecom',
    definitionId: 'task-definition-1',
    replyForward: {
      forwardAssistantText: true,
      forwardToolCalls: true,
      forwardToolResults: true,
    },
    ...overrides,
  } as MessagingConnectionConfig;
}

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    peer: { kind: 'direct', id: 'peer-1' },
    senderId: 'sender-1',
    text: '你好',
    ...overrides,
  };
}

function fakeQueue() {
  const order: string[] = [];
  return {
    order,
    sendBlockReply: vi.fn().mockReturnValue(true),
    sendToolResult: vi.fn().mockReturnValue(true),
    sendFinalReply: vi.fn().mockImplementation(() => { order.push('sendFinalReply'); return true; }),
    markComplete: vi.fn().mockImplementation(() => { order.push('markComplete'); }),
    waitForIdle: vi.fn().mockImplementation(async () => { order.push('waitForIdle'); }),
    getQueuedCounts: vi.fn().mockReturnValue({ block: 0, tool: 0, final: 1 }),
  };
}

function makeHarness(opts: {
  commandHandlers?: IMCommandHandler[];
  injectResult?: boolean | Error;
} = {}) {
  const interceptor = new ReplyInterceptor();
  const agentService = {
    startAgent: vi.fn(),
    resumeAgent: vi.fn(),
    stopAgent: vi.fn(),
    hasAgentInMemory: vi.fn(),
    injectEventToAgent: vi.fn().mockImplementation(async () => {
      if (opts.injectResult instanceof Error) throw opts.injectResult;
      return opts.injectResult ?? true;
    }),
  };
  const agentSessions = {
    ensure: vi.fn().mockImplementation(async (
      _conversation: typeof AGENT_LAUNCH.conversation,
      resolveLaunch: () => typeof AGENT_LAUNCH.launch,
    ) => {
      resolveLaunch();
      return 'agent-1';
    }),
    startNew: vi.fn().mockResolvedValue('agent-2'),
  };
  const pipeline = new InboundPipeline({
    agentService,
    agentSessions: agentSessions as never,
    replyInterceptor: interceptor,
    ...(opts.commandHandlers ? { commandRouter: new IMCommandRouter(opts.commandHandlers) } : {}),
  });
  return { pipeline, interceptor, agentService, agentSessions };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

/** 等待条件成立（媒体校验等真实 fs await 需要多个宏任务才能走完） */
async function waitUntil(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await flush();
  if (!cond()) throw new Error('waitUntil condition not met');
}

beforeEach(() => {
  vi.clearAllMocks();
  (resolveImAgentLaunch as ReturnType<typeof vi.fn>).mockReturnValue(structuredClone(AGENT_LAUNCH));
});

describe('普通消息 Agent 运输段', () => {
  it('顺序：resolve → ensure → setDispatcher → inject → waitForNextYield；yield 后 kind=agent/completion=yield', async () => {
    const { pipeline, interceptor, agentService, agentSessions } = makeHarness();
    const queue = fakeQueue();

    const resultP = pipeline.dispatchWithQueue(bot(), msg(), queue);
    await flush();
    // 已注入且在等 yield
    expect(agentSessions.ensure).toHaveBeenCalledTimes(1);
    const [conversation, resolveLaunch] = agentSessions.ensure.mock.calls[0];
    expect(conversation).toEqual(AGENT_LAUNCH.conversation);
    expect(resolveLaunch()).toEqual(AGENT_LAUNCH.launch);
    expect(agentService.injectEventToAgent).toHaveBeenCalledTimes(1);

    interceptor.processStateEvent('agent-1', { type: 'turn_end' });
    const result = await resultP;
    expect(result).toEqual({ kind: 'agent', completion: 'yield', counts: { block: 0, tool: 0, final: 1 } });
    expect(queue.markComplete).toHaveBeenCalledTimes(1);
    expect(queue.waitForIdle).toHaveBeenCalledTimes(1);
  });

  it('ensure 返回 agentId 后只调用一次 injectEventToAgent，事件 content 为私聊原文', async () => {
    const { pipeline, interceptor, agentService } = makeHarness();
    const queue = fakeQueue();
    const resultP = pipeline.dispatchWithQueue(bot(), msg({ text: '原文 逐字' }), queue);
    await flush();
    interceptor.processStateEvent('agent-1', { type: 'turn_end' });
    await resultP;

    expect(agentService.injectEventToAgent).toHaveBeenCalledTimes(1);
    const [agentId, event] = agentService.injectEventToAgent.mock.calls[0];
    expect(agentId).toBe('agent-1');
    expect(event.content).toBe('原文 逐字');
    expect(event.source).toBe('user');
  });

  it('群聊正文首行为 sender 信封，正文从下一行开始', async () => {
    const { pipeline, interceptor, agentService } = makeHarness();
    const queue = fakeQueue();
    const resultP = pipeline.dispatchWithQueue(
      bot(),
      msg({ peer: { kind: 'group', id: 'room-1' }, senderId: 'u-9', senderName: '张三', text: '早' }),
      queue,
    );
    await flush();
    interceptor.processStateEvent('agent-1', { type: 'turn_end' });
    await resultP;

    const [, event] = agentService.injectEventToAgent.mock.calls[0];
    expect(event.content).toBe('[IM_GROUP_MEMBER {"id":"u-9","name":"张三"}]\n早');
  });

  it('inject 返回 false → completion=inject_rejected、CAS 删除本次 binding、queue 收尾一次', async () => {
    const { pipeline, interceptor } = makeHarness({ injectResult: false });
    const queue = fakeQueue();
    const result = await pipeline.dispatchWithQueue(bot(), msg(), queue);

    expect(result).toMatchObject({ kind: 'agent', completion: 'inject_rejected' });
    expect(queue.markComplete).toHaveBeenCalledTimes(1);
    expect(queue.waitForIdle).toHaveBeenCalledTimes(1);
    // binding 已被 CAS 清理：后续事件无出口
    interceptor.processStateEvent('agent-1', { type: 'assistant_text', content: 'x' });
    expect(queue.sendBlockReply).not.toHaveBeenCalled();
  });

  it('inject 抛错 → CAS 清 binding、queue 收尾后保留原异常上抛', async () => {
    const boom = new Error('lazy resume conflict');
    const { pipeline, interceptor } = makeHarness({ injectResult: boom });
    const queue = fakeQueue();

    await expect(pipeline.dispatchWithQueue(bot(), msg(), queue)).rejects.toBe(boom);
    expect(queue.markComplete).toHaveBeenCalledTimes(1);
    expect(queue.waitForIdle).toHaveBeenCalledTimes(1);
    interceptor.processStateEvent('agent-1', { type: 'assistant_text', content: 'x' });
    expect(queue.sendBlockReply).not.toHaveBeenCalled();
  });

  it('inject 失败时若 dispatcher 已被新消息替换，CAS no-op 不删新出口', async () => {
    const boom = new Error('conflict');
    const { pipeline, interceptor } = makeHarness({ injectResult: boom });
    const queue = fakeQueue();
    const newerQueue = fakeQueue();

    // 让 inject 抛错前新消息已替换 dispatcher：injectEventToAgent 内同步替换
    const svc = (pipeline as unknown as { deps: { agentService: { injectEventToAgent: ReturnType<typeof vi.fn> } } }).deps.agentService;
    svc.injectEventToAgent.mockImplementation(async () => {
      interceptor.setDispatcher('agent-1', 'bot-1', newerQueue, bot().replyForward);
      throw boom;
    });

    await expect(pipeline.dispatchWithQueue(bot(), msg(), queue)).rejects.toBe(boom);
    // 新 dispatcher 仍在
    interceptor.processStateEvent('agent-1', { type: 'assistant_text', content: 'alive' });
    expect(newerQueue.sendBlockReply).toHaveBeenCalledWith({ text: 'alive' });
  });

  it('ensure 抛错 → queue 收尾后原样上抛，不 fallback', async () => {
    const { pipeline, agentService, agentSessions } = makeHarness();
    const boom = new Error('resume failed');
    agentSessions.ensure.mockRejectedValue(boom);
    const queue = fakeQueue();

    await expect(pipeline.dispatchWithQueue(bot(), msg(), queue)).rejects.toBe(boom);
    expect(queue.markComplete).toHaveBeenCalledTimes(1);
    expect(agentService.injectEventToAgent).not.toHaveBeenCalled();
  });

  it('binding 被删除（state-null/bot stop）→ completion=binding_removed，正常收尾', async () => {
    const { pipeline, interceptor } = makeHarness();
    const queue = fakeQueue();
    const resultP = pipeline.dispatchWithQueue(bot(), msg(), queue);
    await flush();
    interceptor.removeBinding('agent-1');
    const result = await resultP;
    expect(result).toMatchObject({ kind: 'agent', completion: 'binding_removed' });
    expect(queue.markComplete).toHaveBeenCalledTimes(1);
  });

  it('两条快速消息不经核心 dispatch-yield 门串行——第二条无需等第一条 yield 即 inject', async () => {
    const { pipeline, interceptor, agentService } = makeHarness();
    const q1 = fakeQueue();
    const q2 = fakeQueue();

    const p1 = pipeline.dispatchWithQueue(bot(), msg({ text: 'M1' }), q1);
    await flush();
    const p2 = pipeline.dispatchWithQueue(bot(), msg({ text: 'M2' }), q2);
    await flush();

    // 第一条尚未 yield，两条都已注入
    expect(agentService.injectEventToAgent).toHaveBeenCalledTimes(2);

    // 任意 turn_end 都释放当时累计的全部 waiter。
    interceptor.processStateEvent('agent-1', { type: 'turn_end' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject({ completion: 'yield' });
    expect(r2).toMatchObject({ completion: 'yield' });
  });
});

describe('命令分流', () => {
  const clearLike = (execute: IMCommandHandler['execute']): IMCommandHandler => ({ name: 'clear', execute });

  it('命中命令 → kind=direct，直接回执经当前 queue，不 setDispatcher、不 ensure、不 inject', async () => {
    const execute = vi.fn().mockResolvedValue({
      handled: true, ok: true, directResponse: { text: '已开始新会话' },
    });
    const { pipeline, interceptor, agentService, agentSessions } = makeHarness({ commandHandlers: [clearLike(execute)] });
    const queue = fakeQueue();

    const result = await pipeline.dispatchWithQueue(bot(), msg({ text: '/clear' }), queue);

    expect(result).toEqual({ kind: 'direct', counts: { block: 0, tool: 0, final: 1 } });
    expect(queue.sendFinalReply).toHaveBeenCalledWith({ text: '已开始新会话' });
    expect(queue.order).toEqual(['sendFinalReply', 'markComplete', 'waitForIdle']);
    expect(agentSessions.ensure).not.toHaveBeenCalled();
    expect(agentService.injectEventToAgent).not.toHaveBeenCalled();
    // 命令直接回执，不创建 Agent binding。
    interceptor.processStateEvent('agent-1', { type: 'assistant_text', content: 'x' });
    expect(queue.sendBlockReply).not.toHaveBeenCalled();
  });

  it('命令 context 为同一自然会话启动新的 AgentRun', async () => {
    const execute = vi.fn().mockImplementation(async (_command, context) => {
      await context.startNewAgent();
      return { handled: true, ok: true, directResponse: { text: 'ok' } };
    });
    const { pipeline, agentSessions } = makeHarness({ commandHandlers: [clearLike(execute)] });
    await pipeline.dispatchWithQueue(bot(), msg({ text: '/clear' }), fakeQueue());
    expect(agentSessions.startNew).toHaveBeenCalledWith(
      AGENT_LAUNCH.conversation,
      AGENT_LAUNCH.launch,
    );
  });

  it('未注册 /foo 走普通消息路径进入 Agent', async () => {
    const execute = vi.fn();
    const { pipeline, interceptor, agentService } = makeHarness({ commandHandlers: [clearLike(execute)] });
    const queue = fakeQueue();
    const resultP = pipeline.dispatchWithQueue(bot(), msg({ text: '/foo' }), queue);
    await flush();
    interceptor.processStateEvent('agent-1', { type: 'turn_end' });
    await resultP;
    expect(execute).not.toHaveBeenCalled();
    expect(agentService.injectEventToAgent).toHaveBeenCalledTimes(1);
    expect(agentService.injectEventToAgent.mock.calls[0][1].content).toBe('/foo');
  });

  it('群聊命令解析在 sender 信封添加前——信封不阻止精确命令命中', async () => {
    const execute = vi.fn().mockResolvedValue({
      handled: true, ok: true, directResponse: { text: 'ok' },
    });
    const { pipeline, agentService } = makeHarness({ commandHandlers: [clearLike(execute)] });
    const result = await pipeline.dispatchWithQueue(
      bot(),
      msg({ peer: { kind: 'group', id: 'room-1' }, senderId: 'u-9', text: '/clear' }),
      fakeQueue(),
    );
    expect(result.kind).toBe('direct');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(agentService.injectEventToAgent).not.toHaveBeenCalled();
  });

  it('/clear 携带媒体仍只执行一次命令，且命令回执完成后清理本次受管文件', async () => {
    const execute = vi.fn().mockResolvedValue({
      handled: true, ok: true, directResponse: { text: 'ok' },
    });
    const { pipeline } = makeHarness({ commandHandlers: [clearLike(execute)] });
    const mediaPath = path.join(getManagedMediaDir(), `test-${createUuid()}.png`);
    fs.writeFileSync(mediaPath, PNG_MAGIC);

    const result = await pipeline.dispatchWithQueue(
      bot(),
      msg({ text: '/clear', media: [{ path: mediaPath }] }),
      fakeQueue(),
    );
    expect(result.kind).toBe('direct');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(mediaPath)).toBe(false);
  });
});

describe('直接拒绝路径', () => {
  it('senderId 无效 → 直接回执拒绝，不 resolve、不 ensure、不 inject', async () => {
    const { pipeline, agentService, agentSessions } = makeHarness();
    const queue = fakeQueue();
    const result = await pipeline.dispatchWithQueue(bot(), msg({ senderId: '  ' }), queue);

    expect(result.kind).toBe('direct');
    expect(queue.sendFinalReply).toHaveBeenCalledWith({ text: SENDER_REJECT_REPLY });
    expect(resolveImAgentLaunch).not.toHaveBeenCalled();
    expect(agentSessions.ensure).not.toHaveBeenCalled();
  });

  it('没有可恢复绑定且 TaskDefinition 缺失 → 明确配置错误直接回执', async () => {
    (resolveImAgentLaunch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new ImTaskDefinitionUnavailableError('task-definition-1');
    });
    const { pipeline, agentSessions } = makeHarness();
    const queue = fakeQueue();
    const result = await pipeline.dispatchWithQueue(bot(), msg(), queue);

    expect(result.kind).toBe('direct');
    expect(queue.sendFinalReply).toHaveBeenCalledWith({ text: TASK_DEFINITION_MISSING_REPLY });
    expect(agentSessions.ensure).toHaveBeenCalledTimes(1);
  });

  it('媒体不受支持 → 整条拒绝不部分消费文本，媒体文件在 finally 清理', async () => {
    const { pipeline, agentService, agentSessions } = makeHarness();
    const badPath = path.join(getManagedMediaDir(), `test-${createUuid()}.pdf`);
    fs.writeFileSync(badPath, Buffer.from('%PDF-1.7'));
    const queue = fakeQueue();

    const result = await pipeline.dispatchWithQueue(
      bot(),
      msg({ text: '带文字也不部分消费', media: [{ path: badPath }] }),
      queue,
    );
    expect(result.kind).toBe('direct');
    expect(queue.sendFinalReply).toHaveBeenCalledWith({ text: UNSUPPORTED_MEDIA_REPLY });
    expect(agentSessions.ensure).not.toHaveBeenCalled();
    expect(agentService.injectEventToAgent).not.toHaveBeenCalled();
    expect(fs.existsSync(badPath)).toBe(false);
  });

  it('正文与媒体都为空 → 边界拒绝，不 ensure/inject', async () => {
    const { pipeline, agentSessions } = makeHarness();
    const result = await pipeline.dispatchWithQueue(bot(), msg({ text: '' }), fakeQueue());
    expect(result).toMatchObject({ kind: 'agent', completion: 'inject_rejected' });
    expect(agentSessions.ensure).not.toHaveBeenCalled();
  });

  it('合法图片 → 转换进 AgentInputEvent.images，成功注入后 finally 清理文件', async () => {
    const { pipeline, interceptor, agentService } = makeHarness();
    const imgPath = path.join(getManagedMediaDir(), `test-${createUuid()}.png`);
    fs.writeFileSync(imgPath, PNG_MAGIC);
    const queue = fakeQueue();

    const resultP = pipeline.dispatchWithQueue(
      bot(),
      msg({ text: '', media: [{ path: imgPath }] }),
      queue,
    );
    await waitUntil(() => agentService.injectEventToAgent.mock.calls.length > 0);
    interceptor.processStateEvent('agent-1', { type: 'turn_end' });
    const result = await resultP;

    expect(result).toMatchObject({ kind: 'agent', completion: 'yield' });
    const [, event] = agentService.injectEventToAgent.mock.calls[0];
    expect(event.content).toBe('');
    expect(event.images).toEqual([{ data: PNG_MAGIC.toString('base64'), media_type: 'image/png' }]);
    // 正文不含路径/占位符
    expect(String(event.content)).not.toContain(imgPath);
    expect(fs.existsSync(imgPath)).toBe(false);
  });
});

describe('停止后 dispatch 不复活 binding', () => {
  it('ensure 期间 abort：不 setDispatcher、不 inject，queue 单次收尾，返回拒绝形状', async () => {
    const { pipeline, interceptor, agentService, agentSessions } = makeHarness();
    const controller = new AbortController();
    agentSessions.ensure.mockImplementation(async () => {
      controller.abort();
      return 'agent-1';
    });
    const setDispatcherSpy = vi.spyOn(interceptor, 'setDispatcher');
    const queue = fakeQueue();

    const result = await pipeline.dispatchWithQueue(bot(), msg(), queue, controller.signal);

    expect(result).toMatchObject({ kind: 'agent', completion: 'inject_rejected' });
    expect(setDispatcherSpy).not.toHaveBeenCalled();
    expect(agentService.injectEventToAgent).not.toHaveBeenCalled();
    expect(queue.markComplete).toHaveBeenCalledTimes(1);
    expect(queue.waitForIdle).toHaveBeenCalledTimes(1);
  });

  it('未提供 signal（渠道旧调用形状）行为不变：正常 ensure → inject → yield', async () => {
    const { pipeline, interceptor, agentService } = makeHarness();
    const queue = fakeQueue();
    const resultP = pipeline.dispatchWithQueue(bot(), msg(), queue);
    await waitUntil(() => agentService.injectEventToAgent.mock.calls.length > 0);
    interceptor.processStateEvent('agent-1', { type: 'turn_end' });
    const result = await resultP;
    expect(result).toMatchObject({ kind: 'agent', completion: 'yield' });
  });
});

describe('pre-abort dispatch 的媒体所有权交接', () => {
  function stageManaged(): string {
    const p = path.join(getManagedMediaDir(), `abort-${createUuid()}.png`);
    fs.writeFileSync(p, PNG_MAGIC);
    return p;
  }

  it('signal 已 abort 的 ctx.dispatchWithQueue：拒绝 ≠ 免除所有权 — 清理受管媒体 + queue 单次收尾，不进 Agent', async () => {
    const { pipeline, agentService, agentSessions } = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const ctx = pipeline.buildContext(bot(), controller.signal);
    const staged = stageManaged();
    const queue = fakeQueue();

    const result = await ctx.dispatchWithQueue(
      msg({ media: [{ path: staged, declaredMediaType: 'image/png' }] }),
      queue as never,
    );

    expect(result).toMatchObject({ kind: 'agent', completion: 'inject_rejected' });
    expect(fs.existsSync(staged)).toBe(false);
    expect(queue.markComplete).toHaveBeenCalledTimes(1);
    expect(queue.waitForIdle).toHaveBeenCalledTimes(1);
    expect(agentSessions.ensure).not.toHaveBeenCalled();
    expect(agentService.injectEventToAgent).not.toHaveBeenCalled();
  });

  it('signal 已 abort 的 ctx.dispatch（callbacks 形状）：同样清理受管媒体', async () => {
    const { pipeline, agentService } = makeHarness();
    const ctx = pipeline.buildContext(bot(), AbortSignal.abort());
    const staged = stageManaged();

    const result = await ctx.dispatch(
      msg({ media: [{ path: staged }] }),
      { deliver: vi.fn() },
    );

    expect(result).toMatchObject({ kind: 'agent', completion: 'inject_rejected' });
    expect(fs.existsSync(staged)).toBe(false);
    expect(agentService.injectEventToAgent).not.toHaveBeenCalled();
  });

  it('pre-abort 清理同样遵守越界不删：受管目录外路径原样保留', async () => {
    const { pipeline } = makeHarness();
    const ctx = pipeline.buildContext(bot(), AbortSignal.abort());
    const outside = path.join(os.tmpdir(), `outside-${createUuid()}.png`);
    fs.writeFileSync(outside, PNG_MAGIC);
    const queue = fakeQueue();
    try {
      await ctx.dispatchWithQueue(msg({ media: [{ path: outside }] }), queue as never);
      expect(fs.existsSync(outside)).toBe(true);
      expect(queue.markComplete).toHaveBeenCalledTimes(1);
      expect(queue.waitForIdle).toHaveBeenCalledTimes(1);
    } finally {
      fs.unlinkSync(outside);
    }
  });
});
