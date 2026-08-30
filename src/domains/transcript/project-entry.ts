/**
 * `ConversationEntry[]` → `TranscriptNode[]`。
 *
 * **纯函数**：不碰 store、不碰 IPC、不读时钟，可直接喂 fixture 测试。
 *
 * 三条必须保持的语义：
 * 1. **两遍扫描**：先按 `toolUseId` 索引全部 `ToolEntry`，再按序处理消息——否则工具结果
 *    早于其调用出现时会配不上。
 * 2. **内容顺序**：assistant 的 Think、正文和工具按最终 ContentBlock 顺序投影。
 * 3. **消息归属**：user 消息是"谁说的话"还是"运行时事件"，由 `messagePresentation.ts`
 *    按 `subtype` 穷尽判定、信封只做覆盖。本文件不解析信封。
 */

import type {
  ConversationEntry,
  MsgEntry,
  PersistedMessageBlock,
  SummaryEntry,
  ToolEntry,
} from '@shared/types/agent-control';
import { parseAssignment } from '@/features/console/data/cells/assignment';
import {
  buildToolNode,
  isDegradedOutcome,
  resolveToolOutcome,
} from '@/features/console/data/cells/toolCell';
import {
  presentUserMessage,
  type NoticeMessagePresentation,
} from '@/features/console/data/cells/messagePresentation';
import {
  assistantSections,
  noticeSections,
  resolveInteraction,
  summarySections,
  userSections,
} from '@/features/console/data/cells/detail';
import { summarizeText } from '@/features/console/data/cells/toolSummary';
import { assistantPolicy, planPolicy } from '@/features/console/data/cells/policy';
import { planTone, staticTone, userTone } from '@/features/console/data/cells/tone';
import type { TitleSource } from '@/features/console/data/cells/toolTitle';
import { resolveToolTitle } from '@/features/console/data/cells/toolTitle';
import type {
  AssistantNode,
  TranscriptNode,
  TranscriptFileRef,
  NoticeNode,
  PlanNode,
  SummaryNode,
  ThinkNode,
  UserNode,
  WorkerNode,
} from './nodes';
import { extractCellMedia } from '@/features/console/data/cells/media';
import {
  messageText,
  rawText as rawPresentationText,
  type PresentationText,
} from '@/features/console/data/presentationText';

// ==================== 常量 ====================

/** 附件文件标记（与发送侧 Composer 的拼接格式对偶） */
// i18n-ignore -- model attachment protocol marker
const ATTACHMENT_MARKER = '附件文件（使用 read 读取）:\n';

/** 成功时抑制：状态已由常驻任务栏承载，时间线里再展示清单是重复噪音 */
const SUPPRESSED_TOOLS = new Set(['task']);

function rawSummary(text: string | undefined, maxLength: number): PresentationText | undefined {
  const summary = summarizeText(text, maxLength);
  return summary ? rawPresentationText(summary) : undefined;
}

function attachmentSummary(imageCount: number, fileCount: number): PresentationText | undefined {
  if (imageCount > 0 && fileCount > 0) {
    return messageText('transcript.summary.imageAndFileCount', {
      imageCount,
      fileCount,
    });
  }
  if (imageCount > 0) {
    return messageText('transcript.summary.imageCount', { count: imageCount });
  }
  if (fileCount > 0) {
    return messageText('transcript.summary.fileCount', { count: fileCount });
  }
  return undefined;
}

// ==================== 用户消息 ====================

interface ParsedUserContent {
  readonly text?: string;
  readonly files?: readonly TranscriptFileRef[];
}

/** 剥离附件文件标记，正文与文件清单分开 */
function splitAttachmentMarker(content: string): ParsedUserContent {
  const markerIdx = content.indexOf(ATTACHMENT_MARKER);
  if (markerIdx === -1) {
    return { text: content || undefined };
  }

  const before = content.substring(0, markerIdx).trim();
  const after = content.substring(markerIdx + ATTACHMENT_MARKER.length);
  const paths = after
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean);

  const files: TranscriptFileRef[] = paths.map((path) => {
    const parts = path.split('/');
    return { name: parts[parts.length - 1] ?? '', path };
  });

  return {
    text: before || undefined,
    files: files.length > 0 ? files : undefined,
  };
}

function readableMessageText(content: MsgEntry['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

const USER_TITLE_KEYS: Record<UserNode['origin'], string> = {
  user: 'transcript.title.userMessage',
  assignment: 'transcript.title.assignment',
  parent: 'transcript.title.parentEvent',
};

function buildUserNode(
  entry: MsgEntry,
  sourceIndex: number,
  origin: UserNode['origin'],
  rawText: string,
): UserNode {
  const images = extractCellMedia(entry.content);

  /**
   * 任务分派要先脱掉 XML 包装再当正文用（`assignment.ts`）。
   * 不脱的话 worker 的第一条消息就是 `<assignment>` / `<prompt>` 加一整段 prompt，
   * 连 dock 的 120 字摘要也以标签开头。
   */
  const assignment = origin === 'assignment' ? parseAssignment(rawText) : undefined;
  const body = assignment ? assignment.prompt : rawText;

  const { text, files } = splitAttachmentMarker(body);

  const meta: PresentationText[] = [];
  if (images?.length) {
    meta.push(messageText('transcript.summary.imageCount', { count: images.length }));
  }
  if (files?.length) {
    meta.push(messageText('transcript.summary.fileCount', { count: files.length }));
  }

  const summary = rawSummary(text, 120) ?? attachmentSummary(images?.length ?? 0, files?.length ?? 0);

  const hasDetail = !!text || !!assignment?.taskBoard;
  const interaction = resolveInteraction({ kind: 'user', sections: [], hasDetail });

  return {
    kind: 'user',
    id: entry.id,
    ts: entry.ts,
    sourceIndex,
    origin,
    titleKey: USER_TITLE_KEYS[origin],
    summary,
    meta: meta.length > 0 ? meta : undefined,
    text,
    images,
    files,
    tone: userTone(origin),
    interaction,
    defaultExpanded: false,
    summaryDuplicatesDetail: false,
    detail: hasDetail
      ? () => ({ sections: userSections(text, assignment?.taskBoard) })
      : undefined,
  };
}

function buildNoticeNode(
  entry: MsgEntry,
  sourceIndex: number,
  presentation: NoticeMessagePresentation,
): NoticeNode {
  const summary =
    rawSummary(presentation.summary, 120)
    ?? rawSummary(presentation.text, 120)
    ?? (presentation.source
      ? messageText('transcript.summary.fromSource', {
          source: rawPresentationText(presentation.source),
        })
      : undefined);
  const interaction = resolveInteraction({
    kind: 'notice',
    sections: [],
    noticeContent: presentation.text,
    hasDetail: !!presentation.text || !!presentation.guidance || !!presentation.details,
  });
  const meta = [
    ...(presentation.source ? [rawPresentationText(presentation.source)] : []),
    ...(presentation.metadata ?? []),
  ];

  return {
    kind: 'notice',
    id: entry.id,
    ts: entry.ts,
    sourceIndex,
    titleKey: presentation.titleKey,
    summary,
    meta: meta.length > 0 ? meta : undefined,
    source: presentation.source,
    text: presentation.text,
    ...(presentation.badge && { badge: presentation.badge }),
    ...(presentation.eventType && { eventType: presentation.eventType }),
    ...(presentation.errorType && { errorType: presentation.errorType }),
    tone: presentation.tone,
    interaction,
    defaultExpanded: presentation.defaultExpanded,
    summaryDuplicatesDetail: false,
    detail: interaction !== 'none'
      ? () => ({
          sections: noticeSections(presentation.text, {
            guidance: presentation.guidance,
            details: presentation.details,
          }),
        })
      : undefined,
  };
}

// ==================== assistant / plan / worker ====================

function buildAssistantNode(
  id: string,
  ts: number,
  sourceIndex: number,
  markdown: string,
): AssistantNode {
  const summary = rawSummary(markdown, 120);
  const policy = assistantPolicy();

  return {
    kind: 'assistant',
    id,
    ts,
    sourceIndex,
    titleKey: 'transcript.title.assistantResponse',
    summary,
    markdown,
    live: false,
    tone: staticTone('assistant'),
    interaction: resolveInteraction({
      kind: 'assistant',
      sections: [],
      assistantText: markdown,
      hasDetail: markdown.trim().length > 0,
    }),
    defaultExpanded: policy.defaultExpanded,
    summaryDuplicatesDetail: false,
    detail: () => ({ sections: assistantSections(markdown) }),
  };
}

function buildThinkNode(
  id: string,
  ts: number,
  sourceIndex: number,
  markdown: string,
): ThinkNode {
  return {
    kind: 'think',
    id,
    ts,
    sourceIndex,
    titleKey: 'transcript.title.thinking',
    markdown,
    live: false,
    tone: 'muted',
    interaction: 'none',
    defaultExpanded: true,
    summaryDuplicatesDetail: false,
  };
}

function buildPlanNode(
  toolUseId: string,
  ts: number,
  sourceIndex: number,
  params: Record<string, unknown>,
  pending: boolean,
): PlanNode {
  const taskSummary = typeof params.taskSummary === 'string' ? params.taskSummary : '';
  const body = typeof params.planDocument === 'string' ? params.planDocument : undefined;

  return {
    kind: 'plan',
    id: toolUseId,
    ts,
    sourceIndex,
    titleKey: 'transcript.title.submitPlan',
    summary: rawSummary(taskSummary, 140),
    taskSummary,
    body,
    pendingCallId: pending ? toolUseId : undefined,
    tone: planTone(pending),
    interaction: 'expand',
    defaultExpanded: planPolicy(pending).defaultExpanded,
    summaryDuplicatesDetail: false,
  };
}

function buildWorkerNode(
  toolUseId: string,
  ts: number,
  sourceIndex: number,
  params: Record<string, unknown>,
): WorkerNode {
  const subject = typeof params.subject === 'string' ? params.subject : '';
  const taskIds = Array.isArray(params.taskIds)
    ? params.taskIds.filter((id): id is string => typeof id === 'string')
    : [];

  const title = resolveToolTitle({ tool: 'subagent', params });
  return {
    kind: 'worker',
    id: toolUseId,
    ts,
    sourceIndex,
    ...title,
    summary: rawSummary(subject, 140),
    workerId: typeof params.id === 'string' ? params.id : '',
    subject,
    mode: typeof params.mode === 'string' ? params.mode : '',
    taskIds,
    tone: staticTone('worker'),
    interaction: 'expand',
    defaultExpanded: false,
    summaryDuplicatesDetail: false,
  };
}

// ==================== 摘要条目 ====================

function buildSummaryNode(entry: SummaryEntry, sourceIndex: number): SummaryNode {
  const summaryData = entry.summary;
  const preview = summarizeText(summaryData.markdown, 200) ?? '';
  const summary = rawSummary(summaryData.markdown, 120)
    ?? messageText('transcript.summary.compacted');

  return {
    kind: 'summary',
    id: `summary-${entry.ts}`,
    ts: entry.ts,
    sourceIndex,
    titleKey: 'transcript.title.logSummary',
    summary,
    compactionId: summaryData.id || `compaction-${entry.ts}`,
    preview,
    tone: staticTone('summary'),
    interaction: resolveInteraction({ kind: 'summary', sections: [], hasDetail: true }),
    defaultExpanded: false,
    summaryDuplicatesDetail: false,
    detail: () => ({ sections: summarySections(summaryData.markdown) }),
  };
}

// ==================== 主出口 ====================

export interface ProjectEntryOptions {
  /** 当前待审批调用的 id；用于把对应工具节点判定为 awaiting-approval */
  readonly pendingCallId?: string;
  readonly titleSource?: TitleSource;
}

export interface IndexedToolResult {
  readonly entry: ToolEntry;
  readonly index: number;
}

export function projectEntryNodes(
  entry: ConversationEntry,
  sourceIndex: number,
  toolResults: ReadonlyMap<string, IndexedToolResult>,
  options: ProjectEntryOptions = {},
): TranscriptNode[] {
  if (entry.t === 'summary') return [buildSummaryNode(entry, sourceIndex)];
  if (entry.t !== 'msg') return [];

  if (entry.role === 'user') {
    const presented = presentUserMessage(entry.subtype, readableMessageText(entry.content));
    return [
      presented.as === 'user'
        ? buildUserNode(entry, sourceIndex, presented.origin, presented.text)
        : buildNoticeNode(entry, sourceIndex, presented),
    ];
  }

  const nodes: TranscriptNode[] = [];
  const content = entry.content;
  if (typeof content === 'string') {
    if (content.trim()) nodes.push(buildAssistantNode(entry.id, entry.ts, sourceIndex, content));
    return nodes;
  }
  if (!Array.isArray(content)) return nodes;

  let textBlockCount = 0;
  content.forEach((block, blockIndex) => {
    if (block.type === 'thinking' && block.thinking?.trim()) {
      nodes.push(buildThinkNode(
        `${entry.id}-think-${blockIndex}`,
        entry.ts,
        sourceIndex,
        block.thinking,
      ));
      return;
    }

    if (block.type === 'openai_reasoning') {
      const markdown = block.summary
        ?.filter((part) => part.text.trim().length > 0)
        .map((part) => part.text)
        .join('\n\n')
        || block.reasoning_content
          ?.filter((part) => part.text.trim().length > 0)
          .map((part) => part.text)
          .join('\n\n')
        || '';
      if (markdown.trim()) {
        nodes.push(buildThinkNode(
          `${entry.id}-think-${blockIndex}`,
          entry.ts,
          sourceIndex,
          markdown,
        ));
      }
      return;
    }

    if (block.type === 'redacted_thinking') return;

    if (block.type === 'text' && block.text?.trim()) {
      textBlockCount += 1;
      const id = textBlockCount === 1
        ? `${entry.id}-text`
        : `${entry.id}-text-${blockIndex}`;
      nodes.push(buildAssistantNode(id, entry.ts, sourceIndex, block.text));
      return;
    }

    if (block.type === 'tool_use' && block.name && block.id) {
      const node = buildToolUseNode(block, entry, sourceIndex, toolResults, options);
      if (node) nodes.push(node);
    }
  });
  return nodes;
}

/** 从完整有序会话构建可确定性重放的节点序列。 */
export function projectConversationNodes(
  entries: readonly ConversationEntry[],
  options: ProjectEntryOptions = {},
): TranscriptNode[] {
  if (entries.length === 0) return [];

  // 第一遍：索引工具结果
  const toolResults = new Map<string, IndexedToolResult>();
  entries.forEach((entry, index) => {
    if (entry.t === 'tool') toolResults.set(entry.toolUseId, { entry, index });
  });

  return entries.flatMap((entry, index) => (
    projectEntryNodes(entry, index, toolResults, options)
  ));
}

/**
 * tool_use 块 → plan / worker / 通用工具节点；`task` 在成功时被抑制。
 *
 * **分派前先定状态**：`resolveToolOutcome()` 对每个 `tool_use` 无条件跑一次，专属呈现
 * 与抑制名单都是它的下游。降级态（failed / cancelled）一律回落通用工具行——那条路径
 * 自带 danger tone、failed badge 与错误文本，因此 PlanNode / WorkerNode 不需要各自
 * 长出一套错误字段，抑制也不会把出错这件事一起吞掉。
 *
 * 专属呈现目前两个（计划卡、子流程行），各占一个 `TranscriptNode['kind']`。**再出现第三个之前
 * 不要继续加 kind**：届时把 plan / worker 并回 `ToolNode` 加一个呈现变体字段，
 * tone/badge/turn/meta/actions 就只剩一套——现在合并是纯结构收益，不值得动
 * `types.ts` 判别联合、`ThreadCell` 与 `useActivitySummary` 三处。
 */
function buildToolUseNode(
  block: Extract<PersistedMessageBlock, { type: 'tool_use' }>,
  entry: MsgEntry,
  sourceIndex: number,
  toolResults: ReadonlyMap<string, IndexedToolResult>,
  options: ProjectEntryOptions,
): TranscriptNode | null {
  const toolUseId = block.id!;
  const toolName = block.name!;

  const params = (block.input ?? undefined) as Record<string, unknown> | undefined;
  const action = typeof params?.action === 'string' ? params.action : undefined;
  const matched = toolResults.get(toolUseId);

  const outcome = resolveToolOutcome({
    toolUseId,
    entry: matched?.entry,
    pendingCallId: options.pendingCallId,
  });
  const degraded = isDegradedOutcome(outcome.state);

  // 状态由常驻任务栏承载，成功的清单写入在时间线里是重复噪音；
  // 失败则任务栏什么也不显示，必须留在时间线上。
  if (SUPPRESSED_TOOLS.has(toolName) && !degraded) return null;

  if (toolName === 'plan' && action === 'create' && !degraded) {
    // 级 1 判据即"待审批"，复用 outcome 里已算好的状态，不再与 pendingCallId 直比
    const pending = outcome.state.phase === 'awaiting-approval';
    return buildPlanNode(
      toolUseId,
      pending || !matched ? entry.ts : matched.entry.ts,
      sourceIndex,
      params ?? {},
      pending,
    );
  }

  if (toolName === 'subagent' && (action === 'create' || !action) && !degraded) {
    return buildWorkerNode(
      toolUseId,
      matched ? matched.entry.ts : entry.ts,
      sourceIndex,
      params ?? {},
    );
  }

  return buildToolNode({
    toolUseId,
    tool: toolName,
    params,
    ts: entry.ts,
    sourceIndex,
    entry: matched?.entry,
    resultTs: matched?.entry.ts,
    outcome,
    titleSource: options.titleSource,
  });
}
