/**
 * 出站投递队列特征测试
 *
 * 锁定四渠道共同消费的 DeliveryQueue（未来统一为 ReplyDispatcher）应保留的产品语义：
 * - sendChain 串行帧序（文本/工具结果/最终回复按入队顺序投递）
 * - 空 payload 不入队
 * - markComplete 只释放 idle 预留位，不是 dispose——迟到帧仍可 enqueue 并投递
 * - onReplyStart 首帧前恰好一次
 * - deliver 失败计入 failedCounts、onError 回调、链继续
 *
 * 四渠道 start()/abort 时序记录（代码核读，供第 5 步 barrier 修正对照）：
 * - feishu: setRuntime→register→setLateSink→monitorFeishuProvider(abortSignal)，
 *   finally: setLateSink(null)+unregister+clearCache 后 settle
 * - qqbot: setRuntime→register→resolveAccount→startGateway(abortSignal)，
 *   finally: unregister 后 settle（vendor 内部 runDiagnostics 在启动 await 期间）
 * - weixin: startAccount({abortSignal})（vendor getUpdates 长轮询），finally: unregister
 * - wecom: monitorWeComProvider({abortSignal}) 直接返回 vendor 长驻 Promise（无框架 finally）
 */

import { describe, it, expect, vi } from 'vitest';



import { createDeliveryQueue } from '../outbound.js';
import type { DeliverPayload, DeliverKind } from '../channel-connector.js';

function collectDeliver() {
  const delivered: Array<{ payload: DeliverPayload; kind: DeliverKind }> = [];
  const deliver = vi.fn(async (payload: DeliverPayload, info: { kind: DeliverKind }) => {
    delivered.push({ payload, kind: info.kind });
  });
  return { delivered, deliver };
}

describe('createDeliveryQueue — 帧序与计数', () => {
  it('按入队顺序串行投递（deliver 异步慢也不乱序）', async () => {
    const delivered: string[] = [];
    const queue = createDeliveryQueue({
      deliver: async (payload) => {
        await new Promise((r) => setTimeout(r, 5));
        delivered.push(payload.text!);
      },
    });

    queue.sendBlockReply({ text: 'b1' });
    queue.sendToolResult({ text: 't1' });
    queue.sendBlockReply({ text: 'b2' });
    queue.sendFinalReply({ text: 'f1' });
    queue.markComplete();
    await queue.waitForIdle();

    expect(delivered).toEqual(['b1', 't1', 'b2', 'f1']);
    expect(queue.getQueuedCounts()).toEqual({ block: 2, tool: 1, final: 1 });
  });

  it('空 payload 不入队，返回 false 且计数不变', async () => {
    const { deliver } = collectDeliver();
    const queue = createDeliveryQueue({ deliver });

    expect(queue.sendBlockReply({ text: '' })).toBe(false);
    expect(queue.sendFinalReply({})).toBe(false);
    expect(queue.getQueuedCounts()).toEqual({ block: 0, tool: 0, final: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('mediaUrl / mediaUrls 视为非空 payload', async () => {
    const { delivered, deliver } = collectDeliver();
    const queue = createDeliveryQueue({ deliver });

    expect(queue.sendFinalReply({ mediaUrl: 'file:///a.png' })).toBe(true);
    expect(queue.sendFinalReply({ mediaUrls: ['file:///b.png'] })).toBe(true);
    queue.markComplete();
    await queue.waitForIdle();
    expect(delivered).toHaveLength(2);
  });
});

describe('createDeliveryQueue — markComplete ≠ dispose', () => {
  it('markComplete 后迟到帧仍可 enqueue 并投递（feishu lateSink 依赖该语义）', async () => {
    const { delivered, deliver } = collectDeliver();
    const queue = createDeliveryQueue({ deliver });

    queue.sendBlockReply({ text: 'early' });
    queue.markComplete();
    await queue.waitForIdle();

    expect(queue.sendFinalReply({ text: 'late' })).toBe(true);
    await queue.waitForIdle();
    expect(delivered.map((d) => d.payload.text)).toEqual(['early', 'late']);
  });

  it('markComplete 幂等：重复调用不影响后续投递', async () => {
    const { delivered, deliver } = collectDeliver();
    const queue = createDeliveryQueue({ deliver });

    queue.markComplete();
    queue.markComplete();
    queue.sendFinalReply({ text: 'still-works' });
    await queue.waitForIdle();
    expect(delivered).toHaveLength(1);
  });
});

describe('createDeliveryQueue — onReplyStart 与错误处理', () => {
  it('onReplyStart 首帧前恰好一次', async () => {
    const order: string[] = [];
    const queue = createDeliveryQueue({
      onReplyStart: async () => { order.push('start'); },
      deliver: async (payload) => { order.push(payload.text!); },
    });

    queue.sendBlockReply({ text: 'a' });
    queue.sendBlockReply({ text: 'b' });
    queue.markComplete();
    await queue.waitForIdle();
    expect(order).toEqual(['start', 'a', 'b']);
  });

  it('deliver 抛错：failedCounts 递增、onError 回调、链继续投递后续帧', async () => {
    const delivered: string[] = [];
    const onError = vi.fn();
    const queue = createDeliveryQueue({
      deliver: async (payload) => {
        if (payload.text === 'boom') throw new Error('send failed');
        delivered.push(payload.text!);
      },
      onError,
    });

    queue.sendBlockReply({ text: 'ok1' });
    queue.sendToolResult({ text: 'boom' });
    queue.sendFinalReply({ text: 'ok2' });
    queue.markComplete();
    await queue.waitForIdle();

    expect(delivered).toEqual(['ok1', 'ok2']);
    expect(queue.getFailedCounts()).toEqual({ block: 0, tool: 1, final: 0 });
    expect(onError).toHaveBeenCalledTimes(1);
    // 排队事实不因失败回滚
    expect(queue.getQueuedCounts()).toEqual({ block: 1, tool: 1, final: 1 });
  });
});
