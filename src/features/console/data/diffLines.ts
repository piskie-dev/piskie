/**
 * 行级 diff —— 审阅面板的底层算法。纯函数，零 React。
 *
 * 用经典 LCS 动态规划回溯出「保留 / 删除 / 新增」序列。之所以不引 diff 库：
 * 这里的输入是 `edit` 的 old_string/new_string，量级是一个 hunk（几行到几十行），
 * 40 行 DP 足够，且能保证输出形状完全受控（行号槽要不要画由调用方决定）。
 *
 * **规模闸门**：LCS 是 O(n·m) 时间与空间。超过 `MAX_CELLS` 就不做精细比对，
 * 退化成「整块删除 + 整块新增」—— 宁可显示得粗，也不要让渲染进程卡住。
 * 这个上限只可能被"整文件当 old_string"的异常调用触发，正常 hunk 到不了。
 */

import type { Token } from '../content/diff/highlight';

/** n·m 的上限（约 4000×4000 会吃 128MB，这里留两个数量级余量） */
const MAX_CELLS = 1_000_000;

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** 旧侧行号（1 起，相对本次比对）；新增行没有 */
  readonly oldNo?: number;
  /** 新侧行号（1 起，相对本次比对）；删除行没有 */
  readonly newNo?: number;
  /**
   * 语法高亮 token（`content/diff/highlight`）。
   * 由 `attachTokens` 事后挂上——diff 算法本身不认识语法，两件事分开。
   * 缺失即按纯文本渲染。
   */
  readonly tokens?: readonly Token[];
}

export interface DiffStat {
  readonly added: number;
  readonly removed: number;
}

export interface LineDiff {
  readonly lines: readonly DiffLine[];
  readonly stat: DiffStat;
  /** true = 因规模退化成整块替换，没有做逐行比对 */
  readonly degraded: boolean;
}

/** 空串按"零行"处理：`''.split('\n')` 会给出 `['']`，那会凭空多一行 */
function toLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

function wholeBlockDiff(oldLines: string[], newLines: string[], degraded: boolean): LineDiff {
  const lines: DiffLine[] = [
    ...oldLines.map((text, index) => ({ kind: 'remove' as const, text, oldNo: index + 1 })),
    ...newLines.map((text, index) => ({ kind: 'add' as const, text, newNo: index + 1 })),
  ];
  return {
    lines,
    stat: { added: newLines.length, removed: oldLines.length },
    degraded,
  };
}

export function diffLines(oldText: string, newText: string): LineDiff {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);

  if (oldLines.length === 0 || newLines.length === 0) {
    return wholeBlockDiff(oldLines, newLines, false);
  }
  if (oldLines.length * newLines.length > MAX_CELLS) {
    return wholeBlockDiff(oldLines, newLines, true);
  }

  const rows = oldLines.length;
  const cols = newLines.length;

  // lcs[i][j] = oldLines[i..] 与 newLines[j..] 的最长公共子序列长度
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i]![j] = oldLines[i] === newLines[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: 'context', text: oldLines[i]!, oldNo: i + 1, newNo: j + 1 });
      i += 1;
      j += 1;
      continue;
    }
    // 删除优先于新增：同一处改动里先列旧行再列新行，读起来是"变成了什么"
    if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: 'remove', text: oldLines[i]!, oldNo: i + 1 });
      removed += 1;
      i += 1;
    } else {
      lines.push({ kind: 'add', text: newLines[j]!, newNo: j + 1 });
      added += 1;
      j += 1;
    }
  }

  while (i < rows) {
    lines.push({ kind: 'remove', text: oldLines[i]!, oldNo: i + 1 });
    removed += 1;
    i += 1;
  }
  while (j < cols) {
    lines.push({ kind: 'add', text: newLines[j]!, newNo: j + 1 });
    added += 1;
    j += 1;
  }

  return { lines, stat: { added, removed }, degraded: false };
}

/**
 * 折叠过长的相同段：只留改动前后各 `context` 行，中间用一条折叠标记代替。
 * 返回值里 `null` 表示"此处省略 N 行"，视图渲染成一条分隔行。
 */
export function collapseContext(
  lines: readonly DiffLine[],
  context = 3,
): readonly (DiffLine | { readonly skipped: number })[] {
  const changed = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'context') return;
    for (let offset = -context; offset <= context; offset += 1) {
      const at = index + offset;
      if (at >= 0 && at < lines.length) changed.add(at);
    }
  });

  const out: (DiffLine | { skipped: number })[] = [];
  let skipping = 0;

  lines.forEach((line, index) => {
    if (changed.has(index)) {
      if (skipping > 0) {
        out.push({ skipped: skipping });
        skipping = 0;
      }
      out.push(line);
      return;
    }
    skipping += 1;
  });

  if (skipping > 0) out.push({ skipped: skipping });
  return out;
}
