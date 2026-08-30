/**
 * IMCommandRouter 注册、分流与异常安全转换
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@electron/observability/logging/app-log.js', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { appLog } from '@electron/observability/logging/app-log.js';
import { IMCommandRouter } from '../command-router.js';
import type { IMCommandContext, IMCommandHandler } from '../command-types.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

const context: IMCommandContext = {
  bot: { id: 'bot-1', name: 'B' } as MessagingConnectionConfig,
  peer: { kind: 'direct', id: 'peer-1' },
  senderId: 'sender-1',
  startNewAgent: vi.fn(async () => 'main-new'),
};

describe('IMCommandRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('未命中命令返回 null，不调用任何 handler', async () => {
    const execute = vi.fn();
    const router = new IMCommandRouter([{ name: 'clear', execute }]);
    expect(await router.tryExecute('普通消息', context)).toBeNull();
    expect(await router.tryExecute('/foo', context)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('命中 handler：透传 ParsedIMCommand 与 context，原样返回结果', async () => {
    const execute = vi.fn().mockResolvedValue({
      handled: true,
      ok: true,
      directResponse: { text: '已开始新会话' },
    });
    const router = new IMCommandRouter([{ name: 'clear', execute }]);
    const result = await router.tryExecute('/clear', context);
    expect(result).toEqual({ handled: true, ok: true, directResponse: { text: '已开始新会话' } });
    expect(execute).toHaveBeenCalledWith({ name: 'clear', args: [], raw: '/clear' }, context);
  });

  it('alias 注册后同 handler 可经别名命中', async () => {
    const execute = vi.fn().mockResolvedValue({
      handled: true,
      ok: true,
      directResponse: { text: 'ok' },
    });
    const handler: IMCommandHandler = { name: 'clear', aliases: ['reset'], execute };
    const router = new IMCommandRouter([handler]);
    expect(await router.tryExecute('/reset', context)).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('handler 抛错：记录完整上下文并转换为 execution_failed 安全文案', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('generation failed'));
    const router = new IMCommandRouter([{ name: 'clear', execute }]);
    const result = await router.tryExecute('/clear', context);
    expect(result).toEqual({
      handled: true,
      ok: false,
      errorCode: 'execution_failed',
      directResponse: { text: '命令执行失败，请稍后重试' },
    });
    expect(appLog.error).toHaveBeenCalledTimes(1);
    // 完整错误上下文进日志：命令名、botId、peer、senderId
    const record = (appLog.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(record).toMatchObject({
      event: 'messaging.command.dispatch.failed',
      context: {
        scope: 'messaging.command',
        commandName: 'clear',
        botId: 'bot-1',
        peerKind: 'direct',
        peerId: 'peer-1',
        senderId: 'sender-1',
      },
      error: expect.any(Error),
    });
  });

  it('重复注册同名命令在构造期 fail fast', () => {
    const h = (name: string): IMCommandHandler => ({
      name,
      execute: async () => ({ handled: true, ok: true, directResponse: { text: 'ok' } }),
    });
    expect(() => new IMCommandRouter([h('clear'), h('clear')])).toThrow(/Duplicate/);
  });

  it('注册第二个命令无需修改分流逻辑', async () => {
    const clearExec = vi
      .fn()
      .mockResolvedValue({ handled: true, ok: true, directResponse: { text: 'c' } });
    const statusExec = vi
      .fn()
      .mockResolvedValue({ handled: true, ok: true, directResponse: { text: 's' } });
    const router = new IMCommandRouter([
      { name: 'clear', execute: clearExec },
      { name: 'status', execute: statusExec },
    ]);
    await router.tryExecute('/status', context);
    expect(statusExec).toHaveBeenCalledTimes(1);
    expect(clearExec).not.toHaveBeenCalled();
  });
});
