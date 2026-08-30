/**
 * unified diff 的真实行号解析。
 *
 * 保留每个 hunk header 的旧/新起始行号，逐行输出带**绝对文件行号**的
 * 结构化行，服务持久审阅面板。
 *
 * 输入只承诺是当前后端 `unifiedDiff()`（jsdiff `createTwoFilesPatch()`）的
 * canonical 输出，不做任意 diff 文件的容错解析；生成器输出与本 parser 契约不一致
 * 属同版本实现错误，由单元测试直接暴露。
 */

export type ParsedDiffLineKind = 'context' | 'add' | 'remove';

export interface ParsedDiffLine {
  readonly kind: ParsedDiffLineKind;
  readonly text: string;
  /** 旧文件绝对行号；add 行没有 */
  readonly oldNo?: number;
  /** 新文件绝对行号；remove 行没有 */
  readonly newNo?: number;
}

export interface ParsedLineDiff {
  readonly lines: readonly ParsedDiffLine[];
  /** 原始 `+` 行数（= 后端 stat 的 linesAdded + linesChanged） */
  readonly added: number;
  /** 原始 `-` 行数（= 后端 stat 的 linesDeleted + linesChanged） */
  readonly removed: number;
}

/** 与后端 createTwoFilesPatch() 输出一致的 hunk header；count 省略时默认 1 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

export function parseUnifiedDiffLines(unifiedDiff: string): ParsedLineDiff {
  const lines: ParsedDiffLine[] = [];
  let added = 0;
  let removed = 0;

  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;

  for (const line of unifiedDiff.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      // 纯新增 hunk 的 old start 可以是 0，纯删除 hunk 的 new start 可以是 0；
      // 只有对应一侧实际输出行时才会用到行号
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      inHunk = true;
      continue;
    }

    // 文件头（===、--- a/、+++ b/、diff --git、index）只出现在首个 hunk 之前
    if (!inHunk) continue;

    if (line.startsWith('\\')) continue; // \ No newline at end of file：不输出、不递增

    if (line.startsWith(' ')) {
      lines.push({ kind: 'context', text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    } else if (line.startsWith('-')) {
      lines.push({ kind: 'remove', text: line.slice(1), oldNo });
      oldNo += 1;
      removed += 1;
    } else if (line.startsWith('+')) {
      lines.push({ kind: 'add', text: line.slice(1), newNo });
      newNo += 1;
      added += 1;
    }
    // 其余（canonical 输出中只有末尾空串）忽略
  }

  return { lines, added, removed };
}
