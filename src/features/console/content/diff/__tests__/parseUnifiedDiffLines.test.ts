/**
 * unified diff 真实行号解析的语法矩阵。
 * fixture 手写覆盖 canonical 语法各分支；「由后端 unifiedDiff() 生成的
 * fixture 防 grammar 漂移」在
 * electron/tools/fs/_lib/__tests__/diff.frontend-roundtrip.test.ts。
 */
import { describe, expect, it } from 'vitest';

import { parseUnifiedDiffLines } from '../parseUnifiedDiffLines';

const HEADER = '--- a/src/demo.ts\n+++ b/src/demo.ts\n';

describe('unified diff parser', () => {
  it('1. 单 hunk 修改且起始行不是 1：行号从 header 起点递增', () => {
    const diff = HEADER
      + '@@ -40,4 +40,4 @@\n'
      + ' before\n'
      + '-old\n'
      + '+new\n'
      + ' after\n';
    const parsed = parseUnifiedDiffLines(diff);
    expect(parsed.lines).toEqual([
      { kind: 'context', text: 'before', oldNo: 40, newNo: 40 },
      { kind: 'remove', text: 'old', oldNo: 41 },
      { kind: 'add', text: 'new', newNo: 41 },
      { kind: 'context', text: 'after', oldNo: 42, newNo: 42 },
    ]);
    expect(parsed.added).toBe(1);
    expect(parsed.removed).toBe(1);
  });

  it('2. 多 hunk 使用各自 old/new start', () => {
    const diff = HEADER
      + '@@ -3,2 +3,2 @@\n'
      + '-a\n'
      + '+A\n'
      + ' keep\n'
      + '@@ -90,2 +90,3 @@\n'
      + ' tail\n'
      + '+appended\n'
      + ' end\n';
    const parsed = parseUnifiedDiffLines(diff);
    expect(parsed.lines[0]).toEqual({ kind: 'remove', text: 'a', oldNo: 3 });
    expect(parsed.lines[1]).toEqual({ kind: 'add', text: 'A', newNo: 3 });
    // 第二个 hunk 从自己的 header 重新起算，不接着第一个 hunk 递增
    expect(parsed.lines[3]).toEqual({ kind: 'context', text: 'tail', oldNo: 90, newNo: 90 });
    expect(parsed.lines[4]).toEqual({ kind: 'add', text: 'appended', newNo: 91 });
    expect(parsed.lines[5]).toEqual({ kind: 'context', text: 'end', oldNo: 91, newNo: 92 });
  });

  it('3. 纯新增 -0,0 +1,n：add 行号从 1 递增', () => {
    const diff = HEADER
      + '@@ -0,0 +1,2 @@\n'
      + '+first\n'
      + '+second\n';
    const parsed = parseUnifiedDiffLines(diff);
    expect(parsed.lines).toEqual([
      { kind: 'add', text: 'first', newNo: 1 },
      { kind: 'add', text: 'second', newNo: 2 },
    ]);
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(0);
  });

  it('4. 纯删除 -1,n +0,0：remove 行号从 old start 递增', () => {
    const diff = HEADER
      + '@@ -1,2 +0,0 @@\n'
      + '-first\n'
      + '-second\n';
    const parsed = parseUnifiedDiffLines(diff);
    expect(parsed.lines).toEqual([
      { kind: 'remove', text: 'first', oldNo: 1 },
      { kind: 'remove', text: 'second', oldNo: 2 },
    ]);
    expect(parsed.added).toBe(0);
    expect(parsed.removed).toBe(2);
  });

  it('5. context/add/remove 两侧递增正确（交错场景）', () => {
    const diff = HEADER
      + '@@ -10,5 +10,5 @@\n'
      + ' c1\n'
      + '-r1\n'
      + '-r2\n'
      + '+a1\n'
      + '+a2\n'
      + ' c2\n'
      + ' c3\n';
    const parsed = parseUnifiedDiffLines(diff);
    expect(parsed.lines).toEqual([
      { kind: 'context', text: 'c1', oldNo: 10, newNo: 10 },
      { kind: 'remove', text: 'r1', oldNo: 11 },
      { kind: 'remove', text: 'r2', oldNo: 12 },
      { kind: 'add', text: 'a1', newNo: 11 },
      { kind: 'add', text: 'a2', newNo: 12 },
      { kind: 'context', text: 'c2', oldNo: 13, newNo: 13 },
      { kind: 'context', text: 'c3', oldNo: 14, newNo: 14 },
    ]);
  });

  it('6. header count 省略时默认 1', () => {
    const diff = HEADER
      + '@@ -7 +7 @@\n'
      + '-only\n'
      + '+ONLY\n';
    const parsed = parseUnifiedDiffLines(diff);
    expect(parsed.lines).toEqual([
      { kind: 'remove', text: 'only', oldNo: 7 },
      { kind: 'add', text: 'ONLY', newNo: 7 },
    ]);
  });

  it('7. \\ No newline at end of file 不占行、不递增行号', () => {
    const diff = HEADER
      + '@@ -1,2 +1,2 @@\n'
      + ' keep\n'
      + '-old\n'
      + '\\ No newline at end of file\n'
      + '+new\n'
      + '\\ No newline at end of file\n';
    const parsed = parseUnifiedDiffLines(diff);
    expect(parsed.lines).toEqual([
      { kind: 'context', text: 'keep', oldNo: 1, newNo: 1 },
      { kind: 'remove', text: 'old', oldNo: 2 },
      { kind: 'add', text: 'new', newNo: 2 },
    ]);
    expect(parsed.added).toBe(1);
    expect(parsed.removed).toBe(1);
  });

  it('8. Windows 路径只影响 header 文本，不影响 hunk 解析', () => {
    const diff = '--- a/C:\\Users\\dev\\file.txt\n'
      + '+++ b/C:\\Users\\dev\\file.txt\n'
      + '@@ -2,2 +2,2 @@\n'
      + '-x\n'
      + '+y\n'
      + ' z\n';
    const parsed = parseUnifiedDiffLines(diff);
    expect(parsed.lines).toEqual([
      { kind: 'remove', text: 'x', oldNo: 2 },
      { kind: 'add', text: 'y', newNo: 2 },
      { kind: 'context', text: 'z', oldNo: 3, newNo: 3 },
    ]);
  });

  it('文件头（===/index 等前导行）在首个 hunk 之前被忽略', () => {
    const diff = '===================================================================\n'
      + HEADER
      + '@@ -1 +1 @@\n'
      + '-a\n'
      + '+b\n';
    const parsed = parseUnifiedDiffLines(diff);
    expect(parsed.lines).toHaveLength(2);
  });
});
