import { describe, expect, it, vi } from 'vitest';



import { ReplyInterceptor } from '../../../reply-interceptor.js';
import type { DeliverPayload, ReplyDispatcher } from '../../../core/channel-connector.js';
import {
  buildToolProgressItem,
  installToolProgressCapability,
} from '../vendor/src/messaging/process-message.js';

function makeDispatcher(): ReplyDispatcher & { frames: DeliverPayload[] } {
  const frames: DeliverPayload[] = [];
  const dispatcher = {
    frames,
    sendBlockReply: vi.fn((payload: DeliverPayload) => { frames.push(payload); return true; }),
    sendToolResult: vi.fn((payload: DeliverPayload) => { frames.push(payload); return true; }),
    sendFinalReply: vi.fn((payload: DeliverPayload) => { frames.push(payload); return true; }),
    markComplete: vi.fn(),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ block: 0, tool: frames.length, final: 0 })),
  } as ReplyDispatcher & { frames: DeliverPayload[] };
  installToolProgressCapability(dispatcher);
  return dispatcher;
}

describe('Weixin native tool progress', () => {
  it('pairs parallel same-name tools by toolCallId and closes each once', () => {
    const dispatcher = makeDispatcher();
    expect(dispatcher.toolProgress?.start({ toolCallId: 'id-1', toolName: 'browser.click' })).toBe(true);
    expect(dispatcher.toolProgress?.start({ toolCallId: 'id-2', toolName: 'browser.click' })).toBe(true);
    expect(dispatcher.toolProgress?.start({ toolCallId: 'id-1', toolName: 'browser.click' })).toBe(false);
    expect(dispatcher.toolProgress?.complete({ toolCallId: 'id-2', toolName: 'browser.click', status: 'completed' })).toBe(true);
    expect(dispatcher.toolProgress?.complete({ toolCallId: 'id-1', toolName: 'browser.click', status: 'failed' })).toBe(true);
    expect(dispatcher.toolProgress?.complete({ toolCallId: 'id-1', toolName: 'browser.click', status: 'failed' })).toBe(false);

    expect(dispatcher.frames.map((payload) => payload.toolProgress)).toEqual([
      { phase: 'start', toolCallId: 'id-1', toolName: 'browser.click' },
      { phase: 'start', toolCallId: 'id-2', toolName: 'browser.click' },
      { phase: 'result', toolCallId: 'id-2', toolName: 'browser.click', status: 'completed' },
      { phase: 'result', toolCallId: 'id-1', toolName: 'browser.click', status: 'failed' },
    ]);
  });

  it('ReplyInterceptor emits native status before optional result text; ask_user stays text', () => {
    const dispatcher = makeDispatcher();
    const interceptor = new ReplyInterceptor();
    interceptor.setDispatcher('agent-1', 'bot-1', dispatcher, {
      forwardAssistantText: false,
      forwardToolCalls: true,
      forwardToolResults: true,
    });

    interceptor.processStateEvent('agent-1', {
      type: 'tool_start', toolCallId: 'tool-1', toolName: 'browser.click', params: { x: 1 },
    });
    interceptor.processStateEvent('agent-1', {
      type: 'tool_finish', ok: true, toolCallId: 'tool-1', toolName: 'browser.click', result: 'ok',
    });
    interceptor.processStateEvent('agent-1', {
      type: 'tool_start', toolCallId: 'ask-1', toolName: 'ask_user', params: { question: '继续吗？' },
    });

    expect(dispatcher.frames[0].toolProgress).toMatchObject({ phase: 'start', toolCallId: 'tool-1' });
    expect(dispatcher.frames[1].toolProgress).toMatchObject({ phase: 'result', toolCallId: 'tool-1', status: 'completed' });
    expect(dispatcher.frames[2].text).toContain('✅ browser.click');
    expect(dispatcher.frames[3].text).toContain('ask_user');
    expect(dispatcher.frames.filter((p) => p.toolProgress?.toolCallId === 'ask-1')).toHaveLength(0);
  });

  it('turn_end and dispatcher replacement close open calls as blocked', () => {
    const first = makeDispatcher();
    const second = makeDispatcher();
    const interceptor = new ReplyInterceptor();
    const config = { forwardAssistantText: false, forwardToolCalls: true, forwardToolResults: false };
    interceptor.setDispatcher('agent-1', 'bot-1', first, config);
    interceptor.processStateEvent('agent-1', {
      type: 'tool_start', toolCallId: 'old', toolName: 'browser.click',
    });
    interceptor.setDispatcher('agent-1', 'bot-1', second, config);
    expect(first.frames.at(-1)?.toolProgress).toMatchObject({ toolCallId: 'old', status: 'blocked' });

    interceptor.processStateEvent('agent-1', {
      type: 'tool_start', toolCallId: 'current', toolName: 'browser.click',
    });
    interceptor.processStateEvent('agent-1', { type: 'turn_end' });
    expect(second.frames.some((p) => p.toolProgress?.toolCallId === 'current'
      && p.toolProgress.status === 'blocked')).toBe(true);
  });

  it('sends a required native completion even when result text forwarding is off', () => {
    const dispatcher = makeDispatcher();
    const interceptor = new ReplyInterceptor();
    interceptor.setDispatcher('agent-1', 'bot-1', dispatcher, {
      forwardAssistantText: false,
      forwardToolCalls: true,
      forwardToolResults: false,
    });
    interceptor.processStateEvent('agent-1', {
      type: 'tool_start', toolCallId: 'tool-1', toolName: 'demo',
    });
    interceptor.processStateEvent('agent-1', {
      type: 'tool_finish', ok: true, toolCallId: 'tool-1', toolName: 'demo', result: 'hidden',
    });
    expect(dispatcher.frames).toHaveLength(2);
    expect(dispatcher.frames[1].toolProgress).toMatchObject({ status: 'completed' });
    expect(dispatcher.frames.some((frame) => frame.text?.includes('hidden'))).toBe(false);
  });

  it('maps a failed tool_finish to native failed without forwarding its text', () => {
    const dispatcher = makeDispatcher();
    const interceptor = new ReplyInterceptor();
    interceptor.setDispatcher('agent-1', 'bot-1', dispatcher, {
      forwardAssistantText: false,
      forwardToolCalls: true,
      forwardToolResults: true,
    });
    interceptor.processStateEvent('agent-1', {
      type: 'tool_start', toolCallId: 'tool-1', toolName: 'demo',
    });
    interceptor.processStateEvent('agent-1', {
      type: 'tool_finish', ok: false, toolCallId: 'tool-1', toolName: 'demo', result: 'hidden failure',
    });
    expect(dispatcher.frames[1].toolProgress).toMatchObject({ status: 'failed' });
    expect(dispatcher.frames.some((frame) => frame.text?.includes('hidden failure'))).toBe(false);
  });

  it('builds the Weixin type 11/12 wire items without text rendering', () => {
    expect(buildToolProgressItem({ phase: 'start', toolCallId: 'id-1', toolName: 'tool.a' })).toMatchObject({
      type: 11,
      is_completed: false,
      tool_call_start_item: { tool_name: 'tool.a', tool_call_id: 'id-1' },
    });
    expect(buildToolProgressItem({
      phase: 'result', toolCallId: 'id-1', toolName: 'tool.a', status: 'completed',
    })).toMatchObject({
      type: 12,
      is_completed: true,
      tool_call_result_item: { tool_name: 'tool.a', tool_call_id: 'id-1', status: 'completed' },
    });
  });
});
