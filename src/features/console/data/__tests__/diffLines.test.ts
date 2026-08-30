/**
 * 行 diff 的单测 —— 审阅面板的底层算法，画错一行就是"改动看起来不是这样"。
 */

import { describe, expect, it } from 'vitest';

import { collapseContext, diffLines } from '../diffLines';

function render(oldText: string, newText: string): string[] {
  return diffLines(oldText, newText).lines.map(
    (line) => `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`,
  );
}

describe('diffLines', () => {
  it('完全相同 ⇒ 全是 context，stat 归零', () => {
    const result = diffLines('a\nb', 'a\nb');
    expect(result.stat).toEqual({ added: 0, removed: 0 });
    expect(result.lines.every((line) => line.kind === 'context')).toBe(true);
  });

  it('中间改一行', () => {
    expect(render('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c']);
  });

  it('同一处改动里删除排在新增之前（读起来是"变成了什么"）', () => {
    const kinds = diffLines('x', 'y').lines.map((line) => line.kind);
    expect(kinds).toEqual(['remove', 'add']);
  });

  it('纯新增（write 的形态）：旧侧为空串 ⇒ 全部 add，行号 1..N', () => {
    const result = diffLines('', 'l1\nl2\nl3');
    expect(result.stat).toEqual({ added: 3, removed: 0 });
    expect(result.lines.map((line) => line.newNo)).toEqual([1, 2, 3]);
    expect(result.lines.every((line) => line.kind === 'add')).toBe(true);
  });

  it('纯删除：新侧为空串 ⇒ 全部 remove', () => {
    const result = diffLines('l1\nl2', '');
    expect(result.stat).toEqual({ added: 0, removed: 2 });
    expect(result.lines.every((line) => line.kind === 'remove')).toBe(true);
  });

  it('空串不算一行（`\'\'.split`会凭空多一行，必须避开）', () => {
    expect(diffLines('', '').lines).toEqual([]);
    expect(diffLines('', '').stat).toEqual({ added: 0, removed: 0 });
  });

  it('行号分别按旧侧 / 新侧各自计数', () => {
    const result = diffLines('a\nb\nc', 'a\nc');
    const removed = result.lines.find((line) => line.kind === 'remove');
    expect(removed?.text).toBe('b');
    expect(removed?.oldNo).toBe(2);
    expect(removed?.newNo).toBeUndefined();

    const lastContext = result.lines.filter((line) => line.kind === 'context').at(-1);
    expect(lastContext?.oldNo).toBe(3);
    expect(lastContext?.newNo).toBe(2);
  });

  it('首尾同时增删', () => {
    expect(render('b', 'a\nb\nc')).toEqual(['+a', ' b', '+c']);
  });

  it('保留空行（空行也是一行）', () => {
    const result = diffLines('a\n\nb', 'a\n\nB');
    expect(result.stat).toEqual({ added: 1, removed: 1 });
    expect(result.lines[1]?.text).toBe('');
  });

  it('规模超限 ⇒ 退化成整块替换并标记 degraded', () => {
    const big = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n');
    const other = Array.from({ length: 1200 }, (_, i) => `other ${i}`).join('\n');
    const result = diffLines(big, other);

    expect(result.degraded).toBe(true);
    expect(result.stat).toEqual({ added: 1200, removed: 1200 });
  });
});

describe('collapseContext', () => {
  it('改动附近的 context 保留，远处折叠成一条标记', () => {
    const lines = diffLines(
      Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'),
      Array.from({ length: 20 }, (_, i) => (i === 10 ? 'CHANGED' : `l${i}`)).join('\n'),
    ).lines;

    const rows = collapseContext(lines, 2);
    const skips = rows.filter((row) => 'skipped' in row);

    expect(skips.length).toBe(2);           // 改动前后各折一段
    expect(rows.some((row) => 'text' in row && row.text === 'CHANGED')).toBe(true);
  });

  it('全是 context ⇒ 整段折叠成一条', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc').lines;
    expect(collapseContext(lines, 2)).toEqual([{ skipped: 3 }]);
  });

  it('短内容不折叠（改动 ± context 已覆盖全部）', () => {
    const lines = diffLines('a\nb', 'a\nB').lines;
    expect(collapseContext(lines, 3).every((row) => !('skipped' in row))).toBe(true);
  });
});
