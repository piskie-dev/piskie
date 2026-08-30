/**
 * ToolEntry.artifacts 的唯一前端投影入口。
 *
 * 后端持久化的是"已执行事实"（shared contract 的 `ToolArtifact`），这里把它投影成
 * 固定 UI slot 的视图数据（`ToolCellArtifact`）。三条铁律：
 * 1. **单入口**：只有本 registry 解释 payload，业务组件不判断工具名、不重复解码；
 * 2. **纯投影**：projector 是纯函数，不维护跨调用缓存或全局 ArtifactStore——
 *    输出是可丢弃派生数据，随 TranscriptNode 销毁、可从 `ToolEntry` 完全重建；
 * 3. **类型穷尽**：`satisfies` 映射类型要求每个 `ToolArtifactKind` 都有 projector，
 *    新增 kind 而未同步前端时编译失败，不留 default/unknown 分支。
 */

import type {
  FileDiffArtifactStat,
  ToolArtifact,
  ToolArtifactKind,
  ToolArtifactOf,
} from '../../../../shared/types';
import {
  grammarForPath,
  tokenize,
  MAX_HIGHLIGHT_LINES,
} from '../content/diff/highlight';
import {
  parseUnifiedDiffLines,
  type ParsedDiffLine,
} from '../content/diff/parseUnifiedDiffLines';
import type { DiffLine, LineDiff } from './diffLines';

// ==================== UI slot 类型 ====================

/** 逐题问答视图（`ask_user_answers` 的投影产物） */
export interface QuestionAnswerItem {
  readonly question: string;
  readonly answer: string;
}

/**
 * 固定 slot 的判别联合——projector 不返回 `Partial<ToolNode>`，不允许覆盖
 * title/summary/state：
 * - `review`：文件变更的权威审阅数据（fileChangeOf / ReviewPanel 消费）
 * - `tool-detail`：对通用结果文本的结构化可读替代（详情 section builder 消费）
 */
export type ToolCellArtifact =
  | Readonly<{
      slot: 'review';
      kind: 'file_diff';
      path: string;
      unifiedDiff: string;
      backendStat: FileDiffArtifactStat;
    }>
  | Readonly<{
      slot: 'tool-detail';
      kind: 'ask_user_answers';
      items: readonly QuestionAnswerItem[];
    }>
  | Readonly<{
      slot: 'tool-detail';
      kind: 'mcp_audio';
      mimeType: string;
      dataUrl: string;
    }>;

export interface ToolArtifactProjectContext {
  /** 配对 tool_use 的 input（问答投影从这里读 questions） */
  readonly params: unknown;
}

type ArtifactProjector<K extends ToolArtifactKind> = (
  artifact: ToolArtifactOf<K>,
  context: ToolArtifactProjectContext,
) => ToolCellArtifact;

// ==================== file_diff → review slot ====================

/**
 * 给带绝对行号的 diff 行挂语法高亮 token。
 *
 * 不能复用 `attachTokens`：它按 `oldNo/newNo - 1` 索引整篇分词结果，而这里的行号是
 * **文件绝对行号**、手头只有 hunk 片段。做法是从 hunk 行重建 old/new 片段文本、
 * 整篇分词（保住跨行结构的核心不变量），再按行在片段内的**相对序**取 token；
 * hunk 之间被拼接，跨 hunk 的块注释可能认错颜色——认错只影响颜色，可接受。
 * 规模闸门与现有 diff 侧同一档（`MAX_HIGHLIGHT_LINES`）。
 */
function attachAbsoluteTokens(lines: readonly ParsedDiffLine[], path: string): DiffLine[] {
  const grammar = grammarForPath(path);
  if (grammar === 'plain' || lines.length > MAX_HIGHLIGHT_LINES) {
    return lines.map((line) => ({ ...line }));
  }

  const oldText = lines.filter((line) => line.kind !== 'add').map((line) => line.text).join('\n');
  const newText = lines.filter((line) => line.kind !== 'remove').map((line) => line.text).join('\n');
  const oldTokens = tokenize(oldText, grammar);
  const newTokens = tokenize(newText, grammar);

  let oldRel = 0;
  let newRel = 0;
  return lines.map((line): DiffLine => {
    if (line.kind === 'remove') return { ...line, tokens: oldTokens[oldRel++] };
    if (line.kind === 'add') return { ...line, tokens: newTokens[newRel++] };
    oldRel += 1;
    return { ...line, tokens: newTokens[newRel++] }; // context 取新侧（两侧文本相同）
  });
}

function projectFileDiff(
  artifact: ToolArtifactOf<'file_diff'>,
  _context: ToolArtifactProjectContext,
): ToolCellArtifact {
  const { path, unifiedDiff, stat } = artifact.payload;
  return { slot: 'review', kind: 'file_diff', path, unifiedDiff, backendStat: stat };
}

export function materializeReviewArtifact(
  artifact: Extract<ToolCellArtifact, { slot: 'review' }>,
): LineDiff {
  const parsed = parseUnifiedDiffLines(artifact.unifiedDiff);
  const diff: LineDiff = {
    lines: attachAbsoluteTokens(parsed.lines, artifact.path),
    // 两向口径：added = linesAdded + linesChanged，与现有 review/activity 一致
    stat: { added: parsed.added, removed: parsed.removed },
    degraded: false,
  };
  return diff;
}

// ==================== ask_user_answers → tool-detail slot ====================

function readQuestions(params: unknown): readonly string[] {
  if (!params || typeof params !== 'object') return [];
  const questions = (params as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((item) => {
    const question = (item as { question?: unknown } | null)?.question;
    return typeof question === 'string' ? question : '';
  });
}

function projectAskUserAnswers(
  artifact: ToolArtifactOf<'ask_user_answers'>,
  context: ToolArtifactProjectContext,
): ToolCellArtifact {
  const questions = readQuestions(context.params);
  // 严格按数组下标配对：问题可重复，不按文本建 Map；生产者保证数量一致
  const items = questions.map((question, index) => ({
    question,
    answer: artifact.payload.answers[index] ?? '',
  }));
  return { slot: 'tool-detail', kind: 'ask_user_answers', items };
}

// ==================== mcp_audio → tool-detail slot ====================

function projectMcpAudio(
  artifact: ToolArtifactOf<'mcp_audio'>,
  _context: ToolArtifactProjectContext,
): ToolCellArtifact {
  const { mimeType, dataBase64 } = artifact.payload;
  return {
    slot: 'tool-detail',
    kind: 'mcp_audio',
    mimeType,
    dataUrl: `data:${mimeType};base64,${dataBase64}`,
  };
}

// ==================== Registry 与入口 ====================

const ARTIFACT_PROJECTORS = {
  file_diff: projectFileDiff,
  ask_user_answers: projectAskUserAnswers,
  mcp_audio: projectMcpAudio,
} satisfies {
  [K in ToolArtifactKind]: ArtifactProjector<K>;
};

function projectOne<K extends ToolArtifactKind>(
  artifact: ToolArtifactOf<K>,
  context: ToolArtifactProjectContext,
): ToolCellArtifact {
  const projector = ARTIFACT_PROJECTORS[artifact.kind] as ArtifactProjector<K>;
  return projector(artifact, context);
}

/** 唯一投影出口：按 kind 查表并收集，缺 artifacts 即 undefined（不产空数组噪声） */
export function projectToolArtifacts(
  artifacts: readonly ToolArtifact[] | undefined,
  context: ToolArtifactProjectContext,
): readonly ToolCellArtifact[] | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  return artifacts.map((artifact) => projectOne(artifact, context));
}
