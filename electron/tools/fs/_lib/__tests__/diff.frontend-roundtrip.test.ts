/**
 * fixture 直接由当前后端 `unifiedDiff()` 生成，
 * 交给前端 `parseUnifiedDiffLines()` 解析——防止前后端 grammar 漂移。
 * 核心不变量：每个解析行的 oldNo/newNo 都指向真实前后内容的对应行（绝对行号），
 * parser 的两向统计由 payload 的三向 stat 换算（added = linesAdded + linesChanged）。
 */
import { describe, expect, it } from 'vitest';

import { unifiedDiff } from '../diff.js';
import {
  parseUnifiedDiffLines,
  type ParsedLineDiff,
} from '../../../../../src/features/console/content/diff/parseUnifiedDiffLines';

/** 生成 → 解析 → 校验绝对行号与 stat 换算，返回解析结果供个案断言 */
function roundTrip(filePath: string, oldContent: string, newContent: string): ParsedLineDiff {
  const diff = unifiedDiff(filePath, oldContent, newContent);
  const parsed = parseUnifiedDiffLines(diff.unifiedDiff);

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  for (const line of parsed.lines) {
    if (line.oldNo !== undefined) {
      expect(oldLines[line.oldNo - 1], `oldNo ${line.oldNo} 应指向旧文件真实行`).toBe(line.text);
    }
    if (line.newNo !== undefined) {
      expect(newLines[line.newNo - 1], `newNo ${line.newNo} 应指向新文件真实行`).toBe(line.text);
    }
  }
  // 后端三向 stat 与前端两向计数的换算。
  expect(parsed.added).toBe(diff.stat.linesAdded + diff.stat.linesChanged);
  expect(parsed.removed).toBe(diff.stat.linesDeleted + diff.stat.linesChanged);
  return parsed;
}

const numbered = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `line-${from + i}`).join('\n') + '\n';

describe('unifiedDiff() 生成 → 前端 parser 往返', () => {
  it('大文件中段修改：起始行不是 1，行号仍指向真实行', () => {
    const before = numbered(1, 100);
    const after = before.replace('line-42', 'line-42-CHANGED');
    const parsed = roundTrip('/w/big.txt', before, after);

    const removed = parsed.lines.find((line) => line.kind === 'remove');
    const added = parsed.lines.find((line) => line.kind === 'add');
    expect(removed).toMatchObject({ text: 'line-42', oldNo: 42 });
    expect(added).toMatchObject({ text: 'line-42-CHANGED', newNo: 42 });
  });

  it('多处修改产生多 hunk：各 hunk 行号独立起算', () => {
    const before = numbered(1, 60);
    const after = before
      .replace('line-5', 'line-5-X')
      .replace('line-50', 'line-50-X');
    const parsed = roundTrip('/w/multi.txt', before, after);

    const adds = parsed.lines.filter((line) => line.kind === 'add');
    expect(adds.map((line) => line.newNo)).toEqual([5, 50]);
  });

  it('纯新增（空 → 内容）：add 行号 1..n', () => {
    const parsed = roundTrip('/w/new.txt', '', 'first\nsecond\n');
    const adds = parsed.lines.filter((line) => line.kind === 'add');
    expect(adds.map((line) => line.newNo)).toEqual([1, 2]);
    expect(parsed.lines.some((line) => line.kind === 'remove')).toBe(false);
  });

  it('纯删除（内容 → 空）：remove 行号 1..n', () => {
    const parsed = roundTrip('/w/gone.txt', 'first\nsecond\n', '');
    const removes = parsed.lines.filter((line) => line.kind === 'remove');
    expect(removes.map((line) => line.oldNo)).toEqual([1, 2]);
    expect(parsed.lines.some((line) => line.kind === 'add')).toBe(false);
  });

  it('尾行无换行符：\\ No newline 标记不进入行流', () => {
    const parsed = roundTrip('/w/noeol.txt', 'a\nend-old', 'a\nend-new');
    expect(parsed.lines.every((line) => !line.text.startsWith('\\'))).toBe(true);
    expect(parsed.lines.filter((line) => line.kind === 'add')).toEqual([
      { kind: 'add', text: 'end-new', newNo: 2 },
    ]);
  });

  it('净增删混合：stat 换算矩阵成立（changed = min(+,-)）', () => {
    const before = 'keep\nold-1\nold-2\nkeep2\n';
    const after = 'keep\nnew-1\nkeep2\nadded-tail\n';
    const diff = unifiedDiff('/w/mixed.txt', before, after);
    // 2 个 - 与 2 个 + → changed=2、netAdded=0、netDeleted=0
    expect(diff.stat).toEqual({ linesAdded: 0, linesDeleted: 0, linesChanged: 2 });
    roundTrip('/w/mixed.txt', before, after);
  });
});
