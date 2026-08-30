/**
 * AskUserTool（工具层）：
 * 校验成功 → suspended 挂起信号（不写结果）；错误路径永不挂起 → 普通校验失败结果。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import { AskUserTool } from '../ask-user.tool.js';
import { parse, toApiSchema } from '../../params.js';
import type { ToolContext } from '../../types.js';

const ctx = {} as ToolContext;

describe('AskUserTool（参数非法立即失败，不挂起）', () => {
  it('工具说明明确触发条件、独占调用和问题结构', () => {
    const tool = new AskUserTool();
    const description = tool.def.description;
    const schema = JSON.stringify(toApiSchema(tool.def.schema));

    expect(description).toContain('需要用户补充信息或作出选择才能继续时调用');
    expect(description).toContain('单独调用，不与其他工具同时调用');
    expect(description).toContain('合并到同一次调用的 questions 数组');
    expect(description).toContain('每个 question 只询问一个事项');
    expect(description).toContain('"options": ["方案 A", "方案 B"]');
    expect(schema).toContain('待用户回答的问题列表');
    expect(schema).toContain('省略时由用户自由回答');
    expect(schema).toContain('是否允许选择多个答案');
  });

  it('合法 questions → suspended 挂起信号', async () => {
    const tool = new AskUserTool();
    const outcome = await tool.execute({ questions: [{ question: '继续吗？', options: ['是', '否'] }] }, ctx);
    expect(outcome).toEqual({ suspended: true, reason: 'user_input' });
  });

  it('空 questions / 缺 questions / 旧单 question 形状在 Coordinator 参数边界被拒绝', () => {
    const tool = new AskUserTool();
    for (const bad of [
      { questions: [] },
      {},
      { question: '旧形状', options: ['A'] },
      { questions: [{ question: '' }] },
    ]) {
      const outcome = parse(tool.def.schema, bad);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.errors.join('\n')).toContain('questions');
    }
  });

  it('schema parse 是唯一参数裁决', () => {
    const tool = new AskUserTool();
    expect(parse(tool.def.schema, { questions: [{ question: 'Q' }] }).ok).toBe(true);
    expect(parse(tool.def.schema, { questions: [] }).ok).toBe(false);
  });
});
