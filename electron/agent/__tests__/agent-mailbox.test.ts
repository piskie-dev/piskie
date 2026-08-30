/**
 * AgentMailbox 单元测试
 * 覆盖：纯队列语义（push/drain 一次性/顺序/snapshot 不消费）、
 * normalizeAgentInputEvent 全函数构造、控制流错误类型。
 */

import { describe, expect, it } from 'vitest';
import type { AgentInputEvent, AgentInputRequest } from '../../../shared/types/index.js';
import {
  AgentMailbox,
  normalizeAgentInputEvent,
  UserInterruptError,
  DisposedError,
  EventBatchApplyError,
} from '../agent-mailbox.js';

function makeEvent(id: string) {
  return normalizeAgentInputEvent({ id, source: 'user', content: `msg-${id}` });
}

describe('AgentMailbox', () => {
  it('push 后 hasEvents/size 反映队列事实', () => {
    const mb = new AgentMailbox();
    expect(mb.hasEvents()).toBe(false);
    expect(mb.size).toBe(0);

    mb.push(makeEvent('a'));
    mb.push(makeEvent('b'));
    expect(mb.hasEvents()).toBe(true);
    expect(mb.size).toBe(2);
  });

  it('drain 取走全部事件且保持入队顺序', () => {
    const mb = new AgentMailbox();
    mb.push(makeEvent('a'));
    mb.push(makeEvent('b'));
    mb.push(makeEvent('c'));

    const events = mb.drain();
    expect(events.map(e => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('每个事件最多 drain 一次：二次 drain 为空', () => {
    const mb = new AgentMailbox();
    mb.push(makeEvent('a'));

    expect(mb.drain()).toHaveLength(1);
    expect(mb.drain()).toHaveLength(0);
    expect(mb.hasEvents()).toBe(false);
  });

  it('drain 返回的数组与后续入队隔离（不共享底层存储）', () => {
    const mb = new AgentMailbox();
    mb.push(makeEvent('a'));
    const first = mb.drain();

    mb.push(makeEvent('b'));
    expect(first.map(e => e.id)).toEqual(['a']);
    expect(mb.drain().map(e => e.id)).toEqual(['b']);
  });

  it('snapshot 按 FIFO 返回且不消费队列', () => {
    const mb = new AgentMailbox();
    mb.push(makeEvent('a'));
    mb.push(makeEvent('b'));

    expect(mb.snapshot().map(event => event.id)).toEqual(['a', 'b']);
    expect(mb.size).toBe(2);
    expect(mb.drain().map(event => event.id)).toEqual(['a', 'b']);
  });

  it('snapshot 返回独立数组，修改副本不影响 Mailbox', () => {
    const mb = new AgentMailbox();
    mb.push(makeEvent('a'));

    const snapshot = mb.snapshot() as AgentInputEvent[];
    snapshot.push(makeEvent('outside'));

    expect(mb.snapshot().map(event => event.id)).toEqual(['a']);
  });

});

describe('normalizeAgentInputEvent（全函数，永不因内容拒绝）', () => {
  it('补全缺失的 id 与 timestamp', () => {
    const event = normalizeAgentInputEvent({ source: 'user', content: 'hi' });
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('保留显式提供的 id 与 timestamp', () => {
    const ts = new Date('2026-01-01T00:00:00Z');
    const event = normalizeAgentInputEvent({ id: 'explicit', timestamp: ts, source: 'user', content: 'hi' });
    expect(event.id).toBe('explicit');
    expect(event.timestamp).toBe(ts);
  });

  it('容忍 IPC 序列化产物：ISO 字符串 timestamp 转回 Date', () => {
    const input = {
      source: 'user',
      content: 'hi',
      timestamp: '2026-01-01T00:00:00.000Z',
    } as unknown as AgentInputRequest;

    const event = normalizeAgentInputEvent(input);
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.timestamp.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('两次归一化生成的 id 不重复', () => {
    const a = normalizeAgentInputEvent({ source: 'user', content: 'x' });
    const b = normalizeAgentInputEvent({ source: 'user', content: 'x' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('控制流错误类型', () => {
  it('UserInterruptError / DisposedError 携带可识别 name', () => {
    expect(new UserInterruptError().name).toBe('UserInterruptError');
    expect(new DisposedError().name).toBe('DisposedError');
  });

  it('EventBatchApplyError 携带批次 event ids 与 cause', () => {
    const cause = new Error('module boom');
    const err = new EventBatchApplyError(['e1', 'e2'], cause);

    expect(err.name).toBe('EventBatchApplyError');
    expect(err.eventIds).toEqual(['e1', 'e2']);
    expect(err.message).toContain('e1');
    expect(err.message).toContain('e2');
    expect(err.cause).toBe(cause);
  });
});
