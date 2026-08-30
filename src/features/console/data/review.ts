/**
 * 单次文件改动 —— 把**一条** write/edit 工具消息还原成「这一次」的可渲染 diff。
 *
 * ## 为什么不再有「改动集」
 *
 * 审阅面只回答一个问题：**「我点的这条消息，改了什么」**。所以这里不再把整条流水
 * 按文件路径聚合成 `ReviewSet`，也不做同一文件多轮次的合并 —— 每条消息各自独立成
 * 一份单次 diff，点哪条看哪次。跨 AgentRun / 全局汇总不在这一层（现阶段不提供，改动大多
 * 发生在子流程，整体审阅另议）。
 *
 * ## 行号口径
 *
 * - `write`：全量内容，行号即 `1..N`，天然准确（`absoluteLines = true`）。
 * - `edit`：优先用后端权威 diff（cell 的 `review` slot / `file_diff`，带真实绝对行号）；
 *   没有 artifact 时退回参数重建的 LCS diff，**不画假行号**（`absoluteLines = false`）。
 *
 * 数据全部从已有的 cell 派生（为什么不直接拿后端 unified diff，见 `cells/fileOp.ts` 头）。
 */

import { attachTokens, grammarForPath, type Grammar } from '../content/diff/highlight';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import { isMutation, type FileOp } from './cells/fileOp';
import { materializeReviewArtifact, type ToolCellArtifact } from './toolArtifacts';
import { diffLines, type DiffStat, type LineDiff } from './diffLines';

/** read 视图直接消费的形状（文件内容 / 文件卡） */
export type ReadOp = Extract<FileOp, { kind: 'read' }>;

/** 一条 write/edit 消息的单次改动，直接喂给审阅面渲染 */
export interface FileChange {
  readonly path: string;
  /** 展示名：路径末段 */
  readonly name: string;
  readonly kind: 'edit' | 'write';
  readonly stat: DiffStat;
  readonly diff: LineDiff;
  /**
   * 行号是否是文件里的真实行号。
   * `write` / 带权威 artifact 的 `edit` ⇒ true；裸参数重建的 `edit` ⇒ false（不画假行号）。
   */
  readonly absoluteLines: boolean;
  readonly replaceAll?: boolean;
}

export function basename(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.at(-1) || filePath;
}

/**
 * 语法高亮在这里挂上，而不是留给视图逐行去做：
 * 跨行结构（块注释、模板字符串）要求**整篇分词**，只有这一层同时握着 old/new 全文。
 */
function highlighted(diff: LineDiff, oldText: string, newText: string, grammar: Grammar): LineDiff {
  return { ...diff, lines: attachTokens(diff.lines, { oldText, newText, grammar }) };
}

/** 从参数重建单次 diff（无后端权威 artifact 时的路径） */
function rebuilt(op: Extract<FileOp, { kind: 'edit' | 'write' }>): FileChange {
  const grammar = grammarForPath(op.path);
  const name = basename(op.path);

  if (op.kind === 'write') {
    // 全量写入：整篇都是新增，行号即 1..N（准确）
    const diff = highlighted(diffLines('', op.content), '', op.content, grammar);
    return { path: op.path, name, kind: 'write', stat: diff.stat, diff, absoluteLines: true };
  }

  const diff = highlighted(diffLines(op.oldText, op.newText), op.oldText, op.newText, grammar);
  return {
    path: op.path,
    name,
    kind: 'edit',
    stat: diff.stat,
    diff,
    absoluteLines: false,
    replaceAll: op.replaceAll,
  };
}

/** `review` slot 的权威 diff（projector 已挂好绝对行号与 token） */
function authoritativeDiff(
  cell: Extract<TranscriptNode, { kind: 'tool' }>,
): Extract<ToolCellArtifact, { slot: 'review' }> | undefined {
  return cell.artifacts?.find(
    (artifact): artifact is Extract<ToolCellArtifact, { slot: 'review' }> =>
      artifact.slot === 'review',
  );
}

/**
 * 把一条 cell 解读成它自己那一次文件改动。
 * 认**成功的**与**待审批的** write/edit —— 审批门的「查看详情」也送到这里
 * （写盘前从参数重建，批准执行后自动升级为带真实行号的权威 diff）。
 * read / 失败 / 非文件工具一律返回 null（read 走 {@link readOpOf}）。
 */
export function fileChangeOf(cell: TranscriptNode): FileChange | null {
  if (cell.kind !== 'tool') return null;
  if (cell.state.phase !== 'ok' && cell.state.phase !== 'awaiting-approval') return null;

  const authoritative = authoritativeDiff(cell);
  if (authoritative) {
    const diff = materializeReviewArtifact(authoritative);
    const fileOp = cell.fileOp;
    return {
      path: authoritative.path,
      name: basename(authoritative.path),
      kind: 'edit',
      stat: diff.stat,
      diff,
      absoluteLines: true,
      replaceAll: fileOp?.kind === 'edit' ? fileOp.replaceAll : undefined,
    };
  }

  const fileOp = cell.fileOp;
  return fileOp && isMutation(fileOp) ? rebuilt(fileOp) : null;
}

/** 被点的这条是不是「读取文件」——是就把 read 载荷取出来给文件视图 */
export function readOpOf(cell: TranscriptNode): ReadOp | null {
  if (cell.kind !== 'tool') return null;
  return cell.fileOp?.kind === 'read' ? cell.fileOp : null;
}
