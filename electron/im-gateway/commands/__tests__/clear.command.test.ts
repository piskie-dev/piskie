import { describe, expect, it, vi } from 'vitest';

import { ClearCommandHandler } from '../clear.command.js';
import { IM_CLEAR_SUCCESS_REPLY } from '../command-messages.js';
import type { IMCommandContext } from '../command-types.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

function makeContext(startNewAgent = vi.fn(async () => 'main-new')): IMCommandContext {
  return {
    bot: { id: 'bot-1', name: 'B' } as MessagingConnectionConfig,
    peer: { kind: 'group', id: 'room-9' },
    senderId: 'sender-1',
    startNewAgent,
  };
}

describe('ClearCommandHandler', () => {
  it('starts one new AgentRun for the current route and returns the direct success reply', async () => {
    const startNewAgent = vi.fn(async () => 'main-new');
    const result = await new ClearCommandHandler().execute(
      { name: 'clear', args: [], raw: '/clear' },
      makeContext(startNewAgent),
    );

    expect(startNewAgent).toHaveBeenCalledOnce();
    expect(IM_CLEAR_SUCCESS_REPLY).toBe(
      '已开始新会话\n\n提示：发送 `/clear` 可以清空当前上下文并开始一个新会话。',
    );
    expect(result).toEqual({
      handled: true,
      ok: true,
      directResponse: { text: IM_CLEAR_SUCCESS_REPLY },
    });
  });

  it('returns invalid_usage for arguments without starting an AgentRun', async () => {
    const startNewAgent = vi.fn(async () => 'main-new');
    const result = await new ClearCommandHandler().execute(
      { name: 'clear', args: ['extra'], raw: '/clear extra' },
      makeContext(startNewAgent),
    );

    expect(result).toEqual({
      handled: true,
      ok: false,
      errorCode: 'invalid_usage',
      directResponse: { text: '用法：/clear' },
    });
    expect(startNewAgent).not.toHaveBeenCalled();
  });

  it('lets route replacement failures reach the Router error boundary', async () => {
    const startNewAgent = vi.fn(async () => {
      throw new Error('start failed');
    });

    await expect(new ClearCommandHandler().execute(
      { name: 'clear', args: [], raw: '/clear' },
      makeContext(startNewAgent),
    )).rejects.toThrow('start failed');
  });
});
