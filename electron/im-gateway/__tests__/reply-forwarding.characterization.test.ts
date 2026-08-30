/**
 * ReplyInterceptor 转发决策特征测试
 *
 * 锁定跨重构应保留的转发产品语义（与运输 Map 结构无关）：
 * - assistant_text → forwardAssistantText 控制 sendBlockReply
 * - tool_start → forwardToolCalls + toolFilter 控制（ask_user 无专用例外路径）
 * - tool_finish(ok=true) → forwardToolResults + 500 字截断
 * - 工具参数外发正文最多 300 字
 * - turn_end → sendFinalReply({text:''}) 结束标记
 * - latest-message-wins：同 agentId 重复 setDispatcher 后内容只发最新出口
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';



import { ReplyInterceptor } from '../reply-interceptor.js';
import type { IMReplyForwardConfig } from '@shared/types/im-gateway.js';

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

describe('ReplyInterceptor 转发决策', () => {
  let interceptor: ReplyInterceptor;
  let dispatcher: ReturnType<typeof fakeDispatcher>;

  beforeEach(() => {
    interceptor = new ReplyInterceptor();
    dispatcher = fakeDispatcher();
  });

  // step 7 已收口 bindings：签名为 (agentId, ownerBotId, dispatcher, config)，转发决策断言不变
  const set = (config?: IMReplyForwardConfig) =>
    interceptor.setDispatcher('agent-1', 'bot-1', dispatcher, config);

  it('forwardAssistantText=true：assistant_text → sendBlockReply(content)', () => {
    set(FULL_FORWARD);
    interceptor.processStateEvent('agent-1', { type: 'assistant_text', content: 'hello' });
    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({ text: 'hello' });
  });

  it('forwardAssistantText=false：assistant_text 不外发', () => {
    set({ ...FULL_FORWARD, forwardAssistantText: false });
    interceptor.processStateEvent('agent-1', { type: 'assistant_text', content: 'hello' });
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it('forwardToolCalls=true 无过滤器：全部工具调用外发，ask_user 走同一路径', () => {
    set(FULL_FORWARD);
    interceptor.processStateEvent('agent-1', { type: 'tool_start', toolName: 'browser_click', params: { x: 1 } });
    interceptor.processStateEvent('agent-1', { type: 'tool_start', toolName: 'ask_user', params: { questions: '继续吗？' } });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(2);
    expect(dispatcher.sendToolResult.mock.calls[1][0].text).toContain('ask_user');
  });

  it('forwardToolCalls=false：包括 ask_user 在内的 tool_start 都不外发', () => {
    set({ ...FULL_FORWARD, forwardToolCalls: false });
    interceptor.processStateEvent('agent-1', { type: 'tool_start', toolName: 'ask_user' });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it('toolFilter include：只外发列表内的工具，ask_user 与其他工具同一过滤逻辑', () => {
    set({ ...FULL_FORWARD, toolFilter: { mode: 'include', tools: ['ask_user'] } });
    interceptor.processStateEvent('agent-1', { type: 'tool_start', toolName: 'ask_user' });
    interceptor.processStateEvent('agent-1', { type: 'tool_start', toolName: 'browser_click' });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendToolResult.mock.calls[0][0].text).toContain('ask_user');
  });

  it('toolFilter exclude：列表内的工具不外发', () => {
    set({ ...FULL_FORWARD, toolFilter: { mode: 'exclude', tools: ['ask_user'] } });
    interceptor.processStateEvent('agent-1', { type: 'tool_start', toolName: 'ask_user' });
    interceptor.processStateEvent('agent-1', { type: 'tool_start', toolName: 'browser_click' });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendToolResult.mock.calls[0][0].text).toContain('browser_click');
  });

  it('tool_start 参数超过现有 300 字展示上限时截断', () => {
    set(FULL_FORWARD);
    interceptor.processStateEvent('agent-1', {
      type: 'tool_start',
      toolName: 'ask_user',
      params: { questions: 'q'.repeat(400) },
    });
    const text = dispatcher.sendToolResult.mock.calls[0][0].text as string;
    expect(text).toContain('...');
    // 300 截断 + 前后缀，不包含完整 400 字参数
    expect(text.length).toBeLessThan(400);
  });

  it('forwardToolResults=true：成功的 tool_finish 外发且 500 字截断', () => {
    set(FULL_FORWARD);
    interceptor.processStateEvent('agent-1', {
      type: 'tool_finish',
      ok: true,
      toolName: 'read',
      result: 'r'.repeat(600),
    });
    const text = dispatcher.sendToolResult.mock.calls[0][0].text as string;
    expect(text).toContain('read');
    expect(text).toContain('...');
  });

  it('失败的 tool_finish 不外发正文', () => {
    set(FULL_FORWARD);
    interceptor.processStateEvent('agent-1', {
      type: 'tool_finish',
      ok: false,
      toolName: 'read',
      result: 'sensitive failure detail',
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it('turn_end → sendFinalReply({text:""}) 结束标记', () => {
    set(FULL_FORWARD);
    interceptor.processStateEvent('agent-1', { type: 'turn_end' });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: '' });
  });

  it('latest-message-wins：重复 setDispatcher 后内容只发最新 dispatcher', () => {
    set(FULL_FORWARD);
    const newer = fakeDispatcher();
    interceptor.setDispatcher('agent-1', 'bot-1', newer, FULL_FORWARD);
    interceptor.processStateEvent('agent-1', { type: 'assistant_text', content: 'x' });
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(newer.sendBlockReply).toHaveBeenCalled();
  });
});
