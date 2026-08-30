/**
 * 工具 cell 构建。
 *
 * 判据优先序——顺序即语义，不可重排：
 *
 * | 级 | 条件 | 结果 |
 * |---|---|---|
 * | 1 | `pendingToolCall.id === toolUseId` | `awaiting-approval` |
 * | 2 | 无匹配 `ToolEntry` | `running` |
 * | 3 | canonical `ok === false` | `failed` |
 * | 4 | a denied/interrupted result | `cancelled` |
 * | 5 | otherwise | `ok` |
 *
 * 状态判定由 `resolveToolOutcome()` 出口，**在分派之前**由 build 侧对每个 `tool_use`
 * 无条件调用一次——包括那些最终不走本文件的专属呈现（计划卡 / 子流程行）与被抑制的
 * 工具。`buildToolNode()` 因此接收算好的 outcome 而不自行计算：类型层保证"分派依据的
 * 状态"与"cell 携带的状态"同源。
 */

import type { PersistedToolResultBlock, ToolEntry } from '../../../../../shared/types/agent-control';
import {
  isJsonLikeString,
  parseMaybeJson,
  summarizeText,
  toolParamsSummary,
  toolResultSummary,
} from './toolSummary';
import {
  toolSections,
  type ToolDetailInput,
} from './detail';
import { extractFileOp } from './fileOp';
import { resolveToolTitle, type TitleSource } from './toolTitle';
import { toolBadge, toolTone } from './tone';
import { toolPolicy } from './policy';
import { projectToolArtifacts, type ToolCellArtifact } from '../toolArtifacts';
import type { TranscriptAction, ToolNode, ToolState } from '@/domains/transcript/nodes';
import { extractCellMedia, type CellMedia } from './media';
import {
  messageText,
  rawText,
  type PresentationText,
} from '../presentationText';

// ==================== 否决 / 中断文案 ====================

const DENIED_PREFIX = 'Tool call denied by user';
// i18n-ignore -- legacy tool-result protocol value
const DENIED_ZH = '用户拒绝了这次操作。';

const INTERRUPT_REASON_KEYS: Readonly<Record<string, string>> = {
  user_interrupted: 'transcript.interrupt.user',
  runtime_interrupted: 'transcript.interrupt.runtime',
  recovery_interrupted: 'transcript.interrupt.recovery',
};

// ==================== ToolEntry 解包 ====================

interface UnpackedResult {
  /** 文本（已剥掉 `<error>` 包裹），或合法 JSON 对象/数组。 */
  readonly result: unknown;
  readonly text: string;
  readonly media?: readonly CellMedia[];
}


/** `- [成功] /path/to.png（备注）` → 路径；行首格式来自 generate-image.tool.ts:197 */
const COMMITTED_IMAGE = /^- \[成功\] (.+?)(?:（.*)?$/;

function extractGeneratedImages(tool: string, state: ToolState, text: string | undefined): readonly string[] | undefined {
  if (tool !== 'generate_image' || state.phase !== 'ok' || !text) return undefined;
  const paths = text
    .split('\n')
    .map((line) => COMMITTED_IMAGE.exec(line.trim())?.[1]?.trim())
    .filter((path): path is string => !!path);
  return paths.length > 0 ? paths : undefined;
}

function unpackToolEntry(entry: ToolEntry): UnpackedResult {
  const texts: string[] = [];
  const media = extractCellMedia(entry.result);

  for (const block of entry.result as readonly PersistedToolResultBlock[]) {
    if (block.type === 'text') {
      texts.push(block.text);
    }
  }

  const persisted = texts.join('\n');
  const wrappedError = persisted.startsWith('<error>') && persisted.endsWith('</error>');
  const text = wrappedError
    ? persisted.slice('<error>'.length, -'</error>'.length)
    : persisted;

  return {
    result: parseMaybeJson(text),
    text,
    media,
  };
}

// ==================== 状态判定 ====================

function resolveToolState(
  toolUseId: string,
  entry: ToolEntry | undefined,
  unpacked: UnpackedResult | undefined,
  pendingCallId: string | undefined,
): ToolState {
  // 级 1
  if (pendingCallId === toolUseId) {
    return { phase: 'awaiting-approval', callId: toolUseId };
  }

  // 级 2
  if (!entry || !unpacked) {
    return { phase: 'running' };
  }

  const { result, text } = unpacked;

  const denied = typeof result === 'string'
    && (result.startsWith(DENIED_PREFIX) || result === DENIED_ZH);
  if (denied) {
    const reason = result.replace(/^Tool call denied by user[.:]?\s*/, '');
    return {
      phase: 'cancelled',
      reason: reason && reason !== DENIED_ZH
        ? rawText(reason)
        : messageText('transcript.summary.cancelled'),
    };
  }

  if (typeof result === 'object' && result !== null) {
    const status = (result as { status?: unknown }).status;
    if (status === 'interrupted') {
      const reasonKey = (result as { reason?: unknown }).reason;
      const messageKey = typeof reasonKey === 'string'
        ? INTERRUPT_REASON_KEYS[reasonKey]
        : undefined;
      return {
        phase: 'cancelled',
        reason: messageText(messageKey ?? 'transcript.interrupt.generic'),
      };
    }
  }

  if (!entry.ok) {
    return { phase: 'failed', error: text };
  }

  return { phase: 'ok' };
}

/** 解包结果 + 状态，一次算完供分派与建 cell 共用 */
export interface ToolOutcome {
  /** 无匹配 `ToolEntry`（执行中 / 待审批）时缺席 */
  readonly unpacked?: UnpackedResult;
  readonly state: ToolState;
}

export interface ResolveToolOutcomeInput {
  readonly toolUseId: string;
  readonly entry?: ToolEntry;
  readonly pendingCallId?: string;
}

/**
 * 每个 `tool_use` 的成败判定唯一入口。build 侧在按工具名分派**之前**调用，
 * 因此专属呈现与抑制名单都建立在同一份状态之上，不存在绕过判定的旁路。
 */
export function resolveToolOutcome(input: ResolveToolOutcomeInput): ToolOutcome {
  const unpacked = input.entry ? unpackToolEntry(input.entry) : undefined;
  return {
    unpacked,
    state: resolveToolState(input.toolUseId, input.entry, unpacked, input.pendingCallId),
  };
}

/**
 * 失败或被否决/中断——这两态下工具**没有产出**，专属呈现无内容可展示，抑制则会让
 * 用户彻底看不见出错这件事：被前置门禁拒绝的调用加上抑制名单里的补救调用，
 * 屏幕上只会剩下几条一模一样的灰字。故降级态一律回落通用工具行，
 * 由 danger tone + failed badge 承载。
 */
export function isDegradedOutcome(state: ToolState): boolean {
  return state.phase === 'failed' || state.phase === 'cancelled';
}

// ==================== 摘要 ====================

function rawSummary(value: string | undefined, maxLength: number): PresentationText | undefined {
  const summary = summarizeText(value, maxLength);
  return summary ? rawText(summary) : undefined;
}

function resolveSummary(view: ToolDetailInput): PresentationText {
  switch (view.state.phase) {
    case 'failed':
      return (!isJsonLikeString(view.state.error) && rawSummary(view.state.error, 120))
        || messageText('transcript.summary.failed');
    case 'cancelled':
      return view.state.reason ?? messageText('transcript.summary.cancelled');
    case 'ok':
      return toolParamsSummary(view)
        ?? toolResultSummary(view)
        ?? messageText('transcript.summary.completed');
    case 'awaiting-approval':
      return toolParamsSummary(view) ?? messageText('transcript.summary.awaitingApproval');
    case 'running':
      return toolParamsSummary(view) ?? messageText('transcript.summary.running');
  }
}

function artifactSummary(
  artifacts: readonly ToolCellArtifact[] | undefined,
): PresentationText | undefined {
  const readable = artifacts?.find((artifact) => artifact.slot === 'tool-detail');
  if (readable?.kind === 'ask_user_answers') {
    return messageText('transcript.summary.answerCount', { count: readable.items.length });
  }
  const audioCount = artifacts?.filter((artifact) => artifact.kind === 'mcp_audio').length ?? 0;
  if (audioCount > 0) {
    return messageText('transcript.summary.audioCount', { count: audioCount });
  }
  const fileDiff = artifacts?.find((artifact) => artifact.kind === 'file_diff');
  return fileDiff?.kind === 'file_diff' ? rawText(fileDiff.path) : undefined;
}

// ==================== meta ====================

function resolveMeta(
  tool: string,
  media: readonly CellMedia[] | undefined,
): PresentationText[] {
  const meta: PresentationText[] = [rawText(tool)];

  if (media && media.length > 0) {
    meta.push(messageText('transcript.summary.imageCount', { count: media.length }));
  }

  return meta;
}

// ==================== 出口 ====================

export interface BuildToolNodeInput {
  readonly toolUseId: string;
  readonly tool: string;
  readonly params: unknown;
  /** tool_use 块所在 msg 的时间戳 */
  readonly ts: number;
  readonly sourceIndex: number;
  /** 配对的结果条目；缺失即"执行中" */
  readonly entry?: ToolEntry;
  /** 结果条目的时间戳：终态显示结果时间而非调用时间 */
  readonly resultTs?: number;
  /** `resolveToolOutcome()` 的产物——分派已用过同一份，不在此重算 */
  readonly outcome: ToolOutcome;
  readonly titleSource?: TitleSource;
}

export function buildToolNode(input: BuildToolNodeInput): ToolNode {
  const { unpacked, state } = input.outcome;

  // 取消态没有产出；详情只保留调用参数与取消原因。
  const carriesResult = state.phase !== 'cancelled';

  // 持久 artifact 一次投影：kind 是 dispatch key，这里不看工具名
  const artifacts = projectToolArtifacts(input.entry?.artifacts, { params: input.params });
  const questionContribution = artifacts?.find(
    (artifact): artifact is Extract<ToolCellArtifact, { kind: 'ask_user_answers' }> =>
      artifact.kind === 'ask_user_answers',
  );
  const audioContributions = artifacts?.filter(
    (artifact): artifact is Extract<ToolCellArtifact, { kind: 'mcp_audio' }> =>
      artifact.kind === 'mcp_audio',
  );

  const view: ToolDetailInput = {
    tool: input.tool,
    params: input.params,
    result: carriesResult ? unpacked?.result : undefined,
    state,
    questionAnswers: carriesResult ? questionContribution?.items : undefined,
    mcpAudio: carriesResult && audioContributions && audioContributions.length > 0
      ? audioContributions
      : undefined,
  };

  const summary = state.phase === 'ok'
    ? artifactSummary(artifacts)
      ?? (unpacked?.media?.length
        ? messageText('transcript.summary.imageCount', { count: unpacked.media.length })
        : undefined)
      ?? resolveSummary(view)
    : resolveSummary(view);
  const policy = toolPolicy(input.tool, state);
  const title = resolveToolTitle(
    { tool: input.tool, params: input.params },
    input.titleSource,
  );

  const interaction = resolveToolInteraction(view, policy.forceInteraction, unpacked?.text.length ?? 0);
  const hasDetail = interaction !== 'none';

  /**
   * 文件操作的结构化载荷（`read`/`write`/`edit`）—— 右栏「审阅」面板的数据源。
   * 挂在 cell 上而不是让面板去翻原始 params：面板不该认识工具参数的形状，
   * 而 cell 已经是"给视图看的东西"。
   */
  const fileOp = extractFileOp({
    tool: input.tool,
    params: input.params,
    resultText: carriesResult ? unpacked?.text : undefined,
    ok: state.phase === 'ok',
  });

  return {
    kind: 'tool',
    id: input.toolUseId,
    ts: state.phase === 'running' || state.phase === 'awaiting-approval'
      ? input.ts
      : (input.resultTs ?? input.ts),
    sourceIndex: input.sourceIndex,
    tool: input.tool,
    ...title,
    summary,
    meta: resolveMeta(input.tool, unpacked?.media),
    tone: toolTone(state),
    badge: toolBadge(state),
    state,
    media: unpacked?.media,
    actions: resolveActions(input.toolUseId, state),
    generatedImages: extractGeneratedImages(input.tool, state, unpacked?.text),
    interaction,
    fileOp,
    artifacts,
    defaultExpanded: policy.defaultExpanded,
    summaryDuplicatesDetail: false,
    detail: hasDetail ? () => ({ sections: toolSections(view) }) : undefined,
  };
}

function resolveToolInteraction(
  view: ToolDetailInput,
  forced: ToolNode['interaction'] | undefined,
  resultTextLength: number,
): ToolNode['interaction'] {
  if (view.state.phase === 'awaiting-approval') return 'preview';
  if (forced) return forced;
  if (view.state.phase === 'failed' && view.state.error.length > 280) return 'modal';
  if (view.state.phase === 'ok' && resultTextLength > 320) return 'modal';
  if (
    view.params !== undefined
    || view.result !== undefined
    || view.questionAnswers !== undefined
    || view.mcpAudio !== undefined
    || view.state.phase === 'failed'
    || (view.state.phase === 'cancelled' && view.state.reason !== undefined)
  ) return 'expand';
  return 'none';
}

/**
 * 「转入后台」只在执行中出现。`enabled` 目前恒为 true——点下去才知道该工具
 * 是否支持后台化；后端补 flag 后在此收紧。
 */
function resolveActions(callId: string, state: ToolState): readonly TranscriptAction[] {
  if (state.phase !== 'running') return [];
  return [{ kind: 'promote-to-background', shortcut: 'mod+b', enabled: true, callId }];
}
