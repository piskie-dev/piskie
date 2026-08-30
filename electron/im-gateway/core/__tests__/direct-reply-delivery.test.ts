/**
 * 直接回执运输：sendFinalReply -> markComplete -> waitForIdle
 */

import { describe, it, expect, vi } from 'vitest';
import { deliverCommandResultDirect, deliverDirectFinalReply } from '../direct-reply-delivery.js';
import type { IMCommandResult } from '../../commands/command-types.js';

function fakeDispatcher(queued = true) {
  const order: string[] = [];
  return {
    order,
    sendBlockReply: vi.fn().mockReturnValue(true),
    sendToolResult: vi.fn().mockReturnValue(true),
    sendFinalReply: vi.fn().mockImplementation(() => { order.push('sendFinalReply'); return queued; }),
    markComplete: vi.fn().mockImplementation(() => { order.push('markComplete'); }),
    waitForIdle: vi.fn().mockImplementation(async () => { order.push('waitForIdle'); }),
    getQueuedCounts: vi.fn().mockReturnValue({ block: 0, tool: 0, final: 1 }),
  };
}

describe('deliverDirectFinalReply', () => {
  it('按序执行 sendFinalReply -> markComplete -> waitForIdle，返回 kind=direct + counts', async () => {
    const d = fakeDispatcher();
    const result = await deliverDirectFinalReply({ text: '已开始新会话' }, d);
    expect(d.order).toEqual(['sendFinalReply', 'markComplete', 'waitForIdle']);
    expect(d.sendFinalReply).toHaveBeenCalledWith({ text: '已开始新会话' });
    expect(result).toEqual({ kind: 'direct', counts: { block: 0, tool: 0, final: 1 } });
  });

  it('不触碰 Agent 路径：只调用 final 运输三件套', async () => {
    const d = fakeDispatcher();
    await deliverDirectFinalReply({ text: 'x' }, d);
    expect(d.sendBlockReply).not.toHaveBeenCalled();
    expect(d.sendToolResult).not.toHaveBeenCalled();
  });

  it('回执未入队：finally 仍执行 markComplete/waitForIdle 后抛错（由上层记录）', async () => {
    const d = fakeDispatcher(false);
    await expect(deliverDirectFinalReply({ text: '' }, d)).rejects.toThrow(/not queued/);
    expect(d.order).toEqual(['sendFinalReply', 'markComplete', 'waitForIdle']);
  });
});

describe('deliverCommandResultDirect', () => {
  it('成功/用法错误/执行失败三种结果都走同一直接运输并返回 kind=direct', async () => {
    const results: IMCommandResult[] = [
      { handled: true, ok: true, directResponse: { text: '已开始新会话' } },
      { handled: true, ok: false, errorCode: 'invalid_usage', directResponse: { text: '用法：/clear' } },
      { handled: true, ok: false, errorCode: 'execution_failed', directResponse: { text: '命令执行失败，请稍后重试' } },
    ];
    for (const r of results) {
      const d = fakeDispatcher();
      const out = await deliverCommandResultDirect(r, d);
      expect(d.sendFinalReply).toHaveBeenCalledWith(r.directResponse);
      expect(d.order).toEqual(['sendFinalReply', 'markComplete', 'waitForIdle']);
      expect(out.kind).toBe('direct');
    }
  });
});
