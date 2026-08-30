/**
 * AgentInputEvent IPC 生产边界校验测试：
 * 合法输入（含 id/timestamp 缺省与多种 timestamp 形态）通过；
 * 非法输入（source 越界、content 形状错误、images 结构缺字段）被拒。
 */

import { describe, expect, it } from 'vitest';
import { agentInputRequestSchema } from '../agent-input.js';

describe('agentInputRequestSchema（生产边界）', () => {
  it('渲染进程完整事件（id + Date timestamp + 图片）通过', () => {
    const result = agentInputRequestSchema.safeParse({
      id: 'evt-1',
      timestamp: new Date(),
      source: 'user',
      content: '你好',
      images: [{ data: 'aGVsbG8=', media_type: 'image/png' }],
    });
    expect(result.success).toBe(true);
  });

  it('id/timestamp 缺省通过（post 入口归一化补全）', () => {
    const result = agentInputRequestSchema.safeParse({
      source: 'user',
      content: '你好',
    });
    expect(result.success).toBe(true);
  });

  it('timestamp 容忍 ISO 字符串与毫秒数（与 normalizeAgentInputEvent 一致）', () => {
    for (const timestamp of ['2026-07-11T00:00:00.000Z', 1780000000000]) {
      const result = agentInputRequestSchema.safeParse({ timestamp, source: 'api', content: 'x' });
      expect(result.success).toBe(true);
    }
  });

  it('无效 timestamp 被拒，Invalid Date 不得越过边界杀死冲程', () => {
    for (const timestamp of ['not-a-date', NaN, Infinity, new Date('garbage')]) {
      const result = agentInputRequestSchema.safeParse({ timestamp, source: 'user', content: 'x' });
      expect(result.success).toBe(false);
    }
  });

  it('content 接受结构化对象', () => {
    const result = agentInputRequestSchema.safeParse({
      source: 'subagent',
      content: { type: 'completed', subagentId: 'sub-1' },
    });
    expect(result.success).toBe(true);
  });

  it('source 越界被拒', () => {
    const result = agentInputRequestSchema.safeParse({ source: 'evil', content: 'x' });
    expect(result.success).toBe(false);
  });

  it('content 缺失或形状错误被拒', () => {
    expect(agentInputRequestSchema.safeParse({ source: 'user' }).success).toBe(false);
    expect(agentInputRequestSchema.safeParse({ source: 'user', content: 42 }).success).toBe(false);
  });

  it('images 缺 media_type 被拒', () => {
    const result = agentInputRequestSchema.safeParse({
      source: 'user',
      content: 'x',
      images: [{ data: 'aGVsbG8=' }],
    });
    expect(result.success).toBe(false);
  });

  it('priority 越界被拒', () => {
    const result = agentInputRequestSchema.safeParse({
      source: 'user',
      content: 'x',
      priority: 'urgent',
    });
    expect(result.success).toBe(false);
  });
});

describe('uiSubmission 生产边界', () => {
  it('不带 uiSubmission 的既有事件全部通过', () => {
    const result = agentInputRequestSchema.safeParse({ source: 'user', content: '你好' });
    expect(result.success).toBe(true);
    expect(result.success && 'uiSubmission' in result.data && result.data.uiSubmission).toBeFalsy();
  });

  it('合法 ask_user_answer 数组通过并保留换行', () => {
    const answers = ['第一行\n第二行', '选项A、自定义'];
    const result = agentInputRequestSchema.safeParse({
      source: 'user',
      content: '1. 问题:…',
      uiSubmission: { kind: 'ask_user_answer', answers },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uiSubmission).toEqual({ kind: 'ask_user_answer', answers });
    }
  });

  it('空 answers 数组是合法形状（数量匹配在配对边界裁决）', () => {
    const result = agentInputRequestSchema.safeParse({
      source: 'user',
      content: 'x',
      uiSubmission: { kind: 'ask_user_answer', answers: [] },
    });
    expect(result.success).toBe(true);
  });

  it('未知 kind 被拒', () => {
    const result = agentInputRequestSchema.safeParse({
      source: 'user',
      content: 'x',
      uiSubmission: { kind: 'evil_submission', answers: ['a'] },
    });
    expect(result.success).toBe(false);
  });

  it('answers 非数组或含非字符串成员被拒', () => {
    for (const answers of ['a', 42, ['a', 1], [null]]) {
      const result = agentInputRequestSchema.safeParse({
        source: 'user',
        content: 'x',
        uiSubmission: { kind: 'ask_user_answer', answers },
      });
      expect(result.success).toBe(false);
    }
  });
});
