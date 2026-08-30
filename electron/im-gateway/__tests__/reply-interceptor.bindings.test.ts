/**
 * ReplyInterceptor 唯一 bindings 表与 yield waiter 语义
 *
 * 覆盖以下出站行为：
 * - setDispatcher 原位更新并复用 yieldWaiters Set；未传 config 时写默认值，不沿用旧值
 * - 只保留唯一 bindings Map，不再维护平行的 dispatcher、config 或 resolver 表
 * - 任意 turn_end 释放该 agentId 当时的全部 waiter，并保留 binding
 * - 单个 waiter 超时只结算自身，不影响同 agent 的其他 waiter
 * - removeBinding(s) 释放 waiter、收尾运输并删除；重复删除保持幂等且清理 timer
 * - lateSink 只条件替换当前 dispatcher，不覆盖新 dispatcher，也不复活已删除的 binding
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';



import { ReplyInterceptor } from '../reply-interceptor.js';
import type { DispatchYieldOutcome } from '../reply-interceptor.js';
import type { IMReplyForwardConfig } from '@shared/types/im-gateway.js';
import { DEFAULT_REPLY_FORWARD_CONFIG } from '../reply-forward-policy.js';

function fakeDispatcher() {
  return {
    sendBlockReply: vi.fn().mockReturnValue(true),
    sendToolResult: vi.fn().mockReturnValue(true),
    sendFinalReply: vi.fn().mockReturnValue(true),
    markComplete: vi.fn(),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    getQueuedCounts: vi.fn().mockReturnValue({ block: 0, tool: 0, final: 0 }),
  };
}

const FULL_FORWARD: IMReplyForwardConfig = {
  forwardAssistantText: true,
  forwardToolCalls: true,
  forwardToolResults: true,
};

/** 把 outcome Promise 收敛成可同步检查的探针 */
function probe(p: Promise<DispatchYieldOutcome>) {
  const state = { settled: false, outcome: undefined as DispatchYieldOutcome | undefined };
  void p.then((o) => { state.settled = true; state.outcome = o; });
  return state;
}

const flush = () => Promise.resolve();

describe('ReplyInterceptor bindings 收口', () => {
  let interceptor: ReplyInterceptor;

  beforeEach(() => {
    vi.useFakeTimers();
    interceptor = new ReplyInterceptor();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('只存在唯一 bindings Map，旧三张表不存在', () => {
    const anyInterceptor = interceptor as unknown as Record<string, unknown>;
    expect(anyInterceptor.bindings).toBeInstanceOf(Map);
    expect(anyInterceptor.dispatchers).toBeUndefined();
    expect(anyInterceptor.agentConfigs).toBeUndefined();
    expect(anyInterceptor.completionResolvers).toBeUndefined();
  });

  it('无 binding 时 waitForNextYield 立即返回 binding_removed', async () => {
    await expect(interceptor.waitForNextYield('nobody')).resolves.toBe('binding_removed');
  });

  it('turn_end 释放该 agent 当时的全部并发 waiter，binding 保留', async () => {
    const d = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d, FULL_FORWARD);
    const w1 = probe(interceptor.waitForNextYield('a1'));
    const w2 = probe(interceptor.waitForNextYield('a1'));

    interceptor.processStateEvent('a1', { type: 'turn_end' });
    await flush();

    expect(w1).toEqual({ settled: true, outcome: 'yield' });
    expect(w2).toEqual({ settled: true, outcome: 'yield' });
    // binding 未删：后续内容仍走同一 dispatcher
    interceptor.processStateEvent('a1', { type: 'assistant_text', content: 'after' });
    expect(d.sendBlockReply).toHaveBeenCalledWith({ text: 'after' });
  });

  it('M1 waiter 超时只结算自身，M2 waiter 不受影响并等到 yield', async () => {
    interceptor.setDispatcher('a1', 'bot-1', fakeDispatcher(), FULL_FORWARD);
    const w1 = probe(interceptor.waitForNextYield('a1', 1_000));
    await vi.advanceTimersByTimeAsync(500);
    const w2 = probe(interceptor.waitForNextYield('a1', 1_000));

    await vi.advanceTimersByTimeAsync(500); // M1 到 1000ms 超时；M2 才过 500ms
    expect(w1).toEqual({ settled: true, outcome: 'timeout' });
    expect(w2.settled).toBe(false);

    interceptor.processStateEvent('a1', { type: 'turn_end' });
    await flush();
    expect(w2).toEqual({ settled: true, outcome: 'yield' });
  });

  it('setDispatcher 原位更新复用 waiter Set——等待中的 waiter 在替换后仍被 turn_end 释放', async () => {
    const d1 = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d1, FULL_FORWARD);
    const w1 = probe(interceptor.waitForNextYield('a1'));

    const d2 = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d2, FULL_FORWARD);

    interceptor.processStateEvent('a1', { type: 'turn_end' });
    await flush();
    expect(w1).toEqual({ settled: true, outcome: 'yield' });
    // 内容走最新 dispatcher（latest-message-wins）
    expect(d2.sendFinalReply).toHaveBeenCalledWith({ text: '' });
    expect(d1.sendFinalReply).not.toHaveBeenCalled();
  });

  it('setDispatcher 未传 config 时写入默认配置，不沿用旧配置', () => {
    const d1 = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d1, FULL_FORWARD);
    const d2 = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d2); // 缺省 config

    // 默认配置 forwardToolCalls=false ⇒ 若沿用旧 FULL_FORWARD 则会外发
    expect(DEFAULT_REPLY_FORWARD_CONFIG.forwardToolCalls).toBe(false);
    interceptor.processStateEvent('a1', { type: 'tool_start', toolName: 'ask_user' });
    expect(d2.sendToolResult).not.toHaveBeenCalled();
  });

  it('removeBinding 以 binding_removed 释放全部 waiter，运输收尾且不再转发', async () => {
    const d = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d, FULL_FORWARD);
    const w1 = probe(interceptor.waitForNextYield('a1'));
    const w2 = probe(interceptor.waitForNextYield('a1'));

    interceptor.removeBinding('a1');
    await flush();
    expect(w1).toEqual({ settled: true, outcome: 'binding_removed' });
    expect(w2).toEqual({ settled: true, outcome: 'binding_removed' });

    interceptor.processStateEvent('a1', { type: 'assistant_text', content: 'late' });
    expect(d.sendBlockReply).not.toHaveBeenCalled();
  });

  it('removeBinding 幂等且清 timer——删除后超时不再触发任何结算', async () => {
    interceptor.setDispatcher('a1', 'bot-1', fakeDispatcher(), FULL_FORWARD);
    const w = probe(interceptor.waitForNextYield('a1', 1_000));
    interceptor.removeBinding('a1');
    interceptor.removeBinding('a1'); // 幂等
    await flush();
    expect(w).toEqual({ settled: true, outcome: 'binding_removed' });
    expect(vi.getTimerCount()).toBe(0); // waiter timer 已随结算清除
  });

  it('removeBindingsByOwner 只清该 Bot 拥有的 binding，其他 Bot 不受影响', async () => {
    const dA = fakeDispatcher();
    const dB = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-A', dA, FULL_FORWARD);
    interceptor.setDispatcher('a2', 'bot-B', dB, FULL_FORWARD);
    const wA = probe(interceptor.waitForNextYield('a1'));
    const wB = probe(interceptor.waitForNextYield('a2'));

    interceptor.removeBindingsByOwner('bot-A');
    await flush();
    expect(wA).toEqual({ settled: true, outcome: 'binding_removed' });
    expect(wB.settled).toBe(false);

    interceptor.processStateEvent('a2', { type: 'assistant_text', content: 'still' });
    expect(dB.sendBlockReply).toHaveBeenCalledWith({ text: 'still' });
  });

  it('removeBindingIfCurrent CAS：命中（同 owner + 同 dispatcher）才删除并返回 true', async () => {
    const d = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d, FULL_FORWARD);
    const w = probe(interceptor.waitForNextYield('a1'));

    expect(interceptor.removeBindingIfCurrent('a1', 'bot-1', d)).toBe(true);
    await flush();
    expect(w).toEqual({ settled: true, outcome: 'binding_removed' });
  });

  it('removeBindingIfCurrent CAS no-op：dispatcher 已被新消息替换/owner 不同/binding 不存在', () => {
    const d1 = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d1, FULL_FORWARD);
    const d2 = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d2, FULL_FORWARD);

    // 旧 dispatcher 的清理不能删掉新消息的出口
    expect(interceptor.removeBindingIfCurrent('a1', 'bot-1', d1)).toBe(false);
    expect(interceptor.removeBindingIfCurrent('a1', 'bot-other', d2)).toBe(false);
    expect(interceptor.removeBindingIfCurrent('missing', 'bot-1', d2)).toBe(false);
    // binding 仍在
    interceptor.processStateEvent('a1', { type: 'assistant_text', content: 'alive' });
    expect(d2.sendBlockReply).toHaveBeenCalledWith({ text: 'alive' });
  });

  it('binding 删除后 lateSink 条件替换返回 false，不复活 binding', () => {
    const d = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d, FULL_FORWARD);
    interceptor.removeBinding('a1');

    const sink = fakeDispatcher();
    expect(interceptor.replaceDispatcherIfCurrent('a1', 'bot-1', d, sink, FULL_FORWARD)).toBe(false);
    interceptor.processStateEvent('a1', { type: 'assistant_text', content: 'x' });
    expect(sink.sendBlockReply).not.toHaveBeenCalled();
    expect(d.sendBlockReply).not.toHaveBeenCalled();
  });

  it('M2 已替换 M1 dispatcher 后，M1 迟到的 lateSink 替换 no-op；M2 自己的替换成功', () => {
    const m1 = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', m1, FULL_FORWARD);
    const m2 = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', m2, FULL_FORWARD);

    const m1Sink = fakeDispatcher();
    expect(interceptor.replaceDispatcherIfCurrent('a1', 'bot-1', m1, m1Sink, FULL_FORWARD)).toBe(false);

    const m2Sink = fakeDispatcher();
    expect(interceptor.replaceDispatcherIfCurrent('a1', 'bot-1', m2, m2Sink, FULL_FORWARD)).toBe(true);
    interceptor.processStateEvent('a1', { type: 'assistant_text', content: 'via-sink' });
    expect(m2Sink.sendBlockReply).toHaveBeenCalledWith({ text: 'via-sink' });
    expect(m1Sink.sendBlockReply).not.toHaveBeenCalled();
    expect(m2.sendBlockReply).not.toHaveBeenCalled();
  });

  it('变体：replaceDispatcherIfCurrent 原位替换保留等待中的 waiter', async () => {
    const d = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d, FULL_FORWARD);
    const w = probe(interceptor.waitForNextYield('a1'));

    const sink = fakeDispatcher();
    expect(interceptor.replaceDispatcherIfCurrent('a1', 'bot-1', d, sink, FULL_FORWARD)).toBe(true);

    interceptor.processStateEvent('a1', { type: 'turn_end' });
    await flush();
    expect(w).toEqual({ settled: true, outcome: 'yield' });
    expect(sink.sendFinalReply).toHaveBeenCalledWith({ text: '' });
  });

  it('replaceDispatcherIfCurrent 未传 config 时重置为默认配置，不沿用旧配置', () => {
    const d = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d, FULL_FORWARD);
    const sink = fakeDispatcher();
    expect(interceptor.replaceDispatcherIfCurrent('a1', 'bot-1', d, sink)).toBe(true);

    interceptor.processStateEvent('a1', { type: 'tool_start', toolName: 'ask_user' });
    expect(sink.sendToolResult).not.toHaveBeenCalled(); // 默认 forwardToolCalls=false
  });

  it('waiter 超时不删 binding：超时后 turn_end 内容仍走原 dispatcher', async () => {
    const d = fakeDispatcher();
    interceptor.setDispatcher('a1', 'bot-1', d, FULL_FORWARD);
    const w = probe(interceptor.waitForNextYield('a1', 1_000));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w).toEqual({ settled: true, outcome: 'timeout' });

    interceptor.processStateEvent('a1', { type: 'turn_end' });
    expect(d.sendFinalReply).toHaveBeenCalledWith({ text: '' });
  });
});
