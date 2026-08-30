/**
 * 任务分派解析的单测。
 *
 * 用户 2026-07-30 反馈：worker 一出现，第一条消息就是 `<assignment>` / `<prompt>`
 * 加一整段 prompt，观感极差。这里把"脱包装"的行为固定住，特别是**回退分支**——
 * 解析失败必须原样保留内容，不能静默丢一条消息。
 *
 * 样例形状取自 `electron/agent/assignment-message.ts` 的实际输出。
 */

import { describe, expect, it } from 'vitest';

import { parseAssignment } from '../assignment';

const REAL = `<assignment>
  <prompt>
在 \`/Users/me/output\` 审查并完善现有网页。

请直接修改代码，重点完成：
1. 静态审查游戏状态切换
  </prompt>
</assignment>

<task_board summary="0/3 完成">
  <item id="t1"
        subject="审查"
        status="pending"
        owner="w1"
        assigned_here="true">
    <depends_on/>
  </item>
</task_board>`;

describe('parseAssignment', () => {
  it('脱掉 XML 包装，正文不含任何标签', () => {
    const parsed = parseAssignment(REAL);

    expect(parsed.parsed).toBe(true);
    expect(parsed.prompt.startsWith('在 `/Users/me/output`')).toBe(true);
    expect(parsed.prompt).not.toContain('<assignment>');
    expect(parsed.prompt).not.toContain('<prompt>');
    expect(parsed.prompt).not.toContain('task_board');
  });

  it('正文内部的换行与列表原样保留（不是压成一行）', () => {
    const parsed = parseAssignment(REAL);

    expect(parsed.prompt).toContain('\n');
    expect(parsed.prompt).toContain('1. 静态审查游戏状态切换');
  });

  it('task_board 单独取出（进 debug 段，不进正文）', () => {
    const parsed = parseAssignment(REAL);

    expect(parsed.taskBoard).toBeDefined();
    expect(parsed.taskBoard).toContain('summary="0/3 完成"');
    expect(parsed.taskBoard).toContain('<item id="t1"');
  });

  it('还原后端为防提前闭合而做的转义', () => {
    const parsed = parseAssignment(
      '<assignment>\n  <prompt>\n讲一下 <\\/prompt> 这个标签\n  </prompt>\n</assignment>',
    );

    expect(parsed.prompt).toBe('讲一下 </prompt> 这个标签');
  });

  it('没有包装时原样返回，且标记为未解析', () => {
    const parsed = parseAssignment('就是一段普通的任务描述');

    expect(parsed.parsed).toBe(false);
    expect(parsed.prompt).toBe('就是一段普通的任务描述');
    expect(parsed.taskBoard).toBeUndefined();
  });

  it('包装残缺（只有开标签）时也不丢内容', () => {
    const raw = '<assignment>\n  <prompt>\n没闭合的正文';
    const parsed = parseAssignment(raw);

    expect(parsed.parsed).toBe(false);
    expect(parsed.prompt).toBe(raw);
  });

  it('只有 task_board 没有 assignment 时，task_board 仍被取出', () => {
    const parsed = parseAssignment('<task_board summary="1/1"></task_board>');

    expect(parsed.parsed).toBe(false);
    expect(parsed.taskBoard).toBe('<task_board summary="1/1"></task_board>');
  });

  it('空 prompt 不抛，得到空正文', () => {
    const parsed = parseAssignment('<assignment>\n  <prompt>\n\n  </prompt>\n</assignment>');

    expect(parsed.parsed).toBe(true);
    expect(parsed.prompt).toBe('');
  });
});
