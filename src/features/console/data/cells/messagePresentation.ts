/**
 * `role: 'user'` 消息的归属判定：**这是谁说的话，还是运行时自己产生的事件**。
 *
 * 模型协议只有 user / assistant 两种角色，所以运行时注入的事件（恢复通知、后台任务
 * 完成…）也只能写成 user 消息。区分它们的唯一可靠依据是后端落盘的 `MsgEntry.subtype`，
 * **不是正文文本**——`agent.service.ts` 注入的"会话已恢复。以下 Worker 已终止…"是一句
 * 裸中文，没有任何信封，与用户手打的消息在文本层面无法区分。
 *
 * 因此判据分两层，方向是"默认保守、明确才升级"：
 *
 * 1. **subtype 给默认归属**（`BY_SUBTYPE`，穷尽映射）——新增 `MessageSubtype`
 *    而未在此登记时编译失败，不留 default 分支。
 * 2. **信封做显式覆盖**（`OVERRIDES`）——只有能证明"这确实是某人说的话"的信封
 *    （`<agent_input>`）才把归属升级成消息气泡；其余信封只是把事件行的
 *    source / 摘要填得好看些。
 *
 * 未登记的信封不会改变默认归属。这是所有未来注入点的安全网：忘了登记，最坏是显示成
 * 一条中性事件行，而不会伪装成用户发言——反过来兜底（认不出信封就当用户发言）会让运行时
 * 事件显示成"用户输入的状态"。
 */

import type { MessageSubtype } from '../../../../../shared/types';
import {
  isSubagentEventType,
  type SubagentEventType,
} from '../../../../../shared/subagent-events';
import type { TranscriptBadge, TranscriptTone, UserNode } from '@/domains/transcript/nodes';
import {
  messageText,
  rawText,
  type PresentationText,
} from '../presentationText';

export type { SubagentEventType } from '../../../../../shared/subagent-events';

// ==================== 归属 ====================

export type MessagePresentation =
  | {
      readonly as: 'user';
      readonly origin: UserNode['origin'];
      /** 供 `buildUserCell` 使用的正文（信封已剥离；assignment 保持原文由其自行解包） */
      readonly text: string;
    }
  | {
      readonly as: 'notice';
      readonly source: string;
      readonly text: string;
      /** 信封自带人话摘要时覆盖，否则折叠态会显示 XML 首行 */
      readonly summary?: string;
      readonly titleKey: string;
      readonly tone: TranscriptTone;
      readonly badge?: TranscriptBadge;
      readonly defaultExpanded: boolean;
      readonly eventType?: SubagentEventType;
      readonly errorType?: string;
      readonly metadata?: readonly PresentationText[];
      readonly details?: Readonly<Record<string, unknown>>;
      readonly guidance?: PresentationText;
    };

export type NoticeMessagePresentation = Extract<MessagePresentation, { readonly as: 'notice' }>;

interface NoticeStyle {
  readonly titleKey: string;
  readonly tone: TranscriptTone;
  readonly badge?: TranscriptBadge;
  readonly defaultExpanded: boolean;
}

const DEFAULT_NOTICE_STYLE: NoticeStyle = {
  titleKey: 'transcript.notice.eventReceived',
  tone: 'neutral',
  defaultExpanded: false,
};

const SUBAGENT_NOTICE_STYLES = {
  message: { titleKey: 'transcript.notice.workerMessage', tone: 'neutral', defaultExpanded: false },
  completed: { titleKey: 'transcript.notice.workerCompleted', tone: 'neutral', defaultExpanded: false },
  failed: { titleKey: 'transcript.notice.workerFailed', tone: 'danger', defaultExpanded: false },
  user_stopped: { titleKey: 'transcript.notice.workerStopped', tone: 'warning', badge: 'cancelled', defaultExpanded: false },
  need_user_action: { titleKey: 'transcript.notice.userActionRequired', tone: 'warning', defaultExpanded: true },
  stalled: { titleKey: 'transcript.notice.workerStalled', tone: 'warning', defaultExpanded: true },
} as const satisfies Record<SubagentEventType, NoticeStyle>;

const ERROR_GUIDANCE_KEYS: Readonly<Record<string, string>> = {
  context_overflow: 'transcript.guidance.contextOverflow',
};

interface NoticeInput {
  readonly source: string;
  readonly text: string;
  readonly summary?: string;
  readonly eventType?: SubagentEventType;
  readonly errorType?: string;
  readonly metadata?: readonly PresentationText[];
  readonly details?: Readonly<Record<string, unknown>>;
}

function presentNotice(input: NoticeInput): NoticeMessagePresentation {
  const style = input.eventType
    ? SUBAGENT_NOTICE_STYLES[input.eventType]
    : DEFAULT_NOTICE_STYLE;
  const guidanceKey = input.errorType
    ? ERROR_GUIDANCE_KEYS[input.errorType]
    : undefined;
  return {
    as: 'notice',
    source: input.source,
    text: input.text,
    ...(input.summary && { summary: input.summary }),
    ...style,
    ...(input.eventType && { eventType: input.eventType }),
    ...(input.errorType && { errorType: input.errorType }),
    ...(input.metadata && input.metadata.length > 0 && { metadata: input.metadata }),
    ...(input.details && Object.keys(input.details).length > 0 && { details: input.details }),
    ...(guidanceKey
      ? { guidance: messageText(guidanceKey) }
      : {}),
  };
}

type DefaultPresentation =
  | { readonly as: 'user'; readonly origin: UserNode['origin'] }
  | { readonly as: 'notice' };

/**
 * subtype → 默认归属。`satisfies` 保证穷尽：`MessageSubtype` 加值必须在此决策。
 *
 * - `system_task` 是顶层任务描述（`director.role.ts`），那就是用户派的活，归气泡；
 * - `system_event` 覆盖 agent_input / closure_check / 恢复通知 / 后台任务通知四类，
 *   默认事件行，其中只有 agent_input 由覆盖层升级；
 * - `context_summary` 只存在于压缩后重建的内存消息列表，从不落盘，前端不可达，
 *   在此仅为满足穷尽。
 */
const BY_SUBTYPE = {
  user_input: { as: 'user', origin: 'user' },
  system_task: { as: 'user', origin: 'user' },
  assignment: { as: 'user', origin: 'assignment' },
  system_event: { as: 'notice' },
  subagent_notification: { as: 'notice' },
  context_summary: { as: 'notice' },
} as const satisfies Record<MessageSubtype, DefaultPresentation>;

// ==================== 信封覆盖 ====================

/**
 * 外部注入事件：确有来源方，是"别人说的话"，升级为消息气泡。
 * source 以 `parent` 开头时用父级色，其余按普通消息处理。
 */
function externalOverride(source: string, body: string): MessagePresentation {
  return { as: 'user', origin: source.startsWith('parent') ? 'parent' : 'user', text: body };
}

function attribute(attributes: string, name: string): string | undefined {
  const encoded = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
  if (encoded === undefined) return undefined;
  return encoded
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function eventDiagnostics(
  attributes: string,
  source: string,
  eventType: SubagentEventType | undefined,
  errorType: string | undefined,
): { metadata: PresentationText[]; details: Record<string, unknown> } {
  const fields = [
    ['origin', 'origin', 'transcript.meta.origin'],
    ['provider', 'provider', 'transcript.meta.provider'],
    ['model', 'model', 'transcript.meta.model'],
    ['request_id', 'requestId', 'transcript.meta.requestId'],
    ['trace_id', 'traceId', 'transcript.meta.traceId'],
  ] as const;
  const metadata: PresentationText[] = [];
  const details: Record<string, unknown> = {
    ...(source && { subagentId: source }),
    ...(eventType && { type: eventType }),
    ...(errorType && { errorType }),
  };
  for (const [attributeName, detailName, messageKey] of fields) {
    const value = attribute(attributes, attributeName);
    if (!value) continue;
    metadata.push(messageText(messageKey, { value: rawText(value) }));
    details[detailName] = value;
  }
  return { metadata, details };
}

/**
 * 信封覆盖表。返回 undefined 表示"这个信封不改变默认归属"。
 *
 * 顺序即优先级；每条都必须显式列出信封形状，不做前缀通配——通配会让未来的新信封
 * 意外落进某条已有规则。
 */
function envelopeOverride(text: string): MessagePresentation | undefined {
  const externalXml = text.match(/^<agent_input\b([^>]*)>\n?([\s\S]*?)\n?<\/agent_input>$/);
  if (externalXml) {
    return externalOverride(
      (externalXml[1] ?? '').match(/source="([^"]*)"/)?.[1] ?? '',
      externalXml[2] ?? text,
    );
  }

  const subpiskieml = text.match(/^<subagent_event\b([^>]*)>\n?([\s\S]*?)\n?<\/subagent_event>$/);
  if (subpiskieml) {
    const attributes = subpiskieml[1] ?? '';
    const body = subpiskieml[2] ?? text;
    const source = attribute(attributes, 'id') ?? '';
    const rawEventType = attribute(attributes, 'type');
    const eventType = isSubagentEventType(rawEventType) ? rawEventType : undefined;
    const errorType = attribute(attributes, 'error_type');
    const diagnostics = eventDiagnostics(attributes, source, eventType, errorType);
    return presentNotice({
      source,
      text: body,
      summary: body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || undefined,
      eventType,
      errorType,
      metadata: diagnostics.metadata,
      details: diagnostics.details,
    });
  }

  const closure = text.match(/^<closure_check\b[^>]*\/>\n?([\s\S]*)$/);
  if (closure) return presentNotice({ source: 'closure_check', text: closure[1] ?? '' });

  // 后台任务完成通知（`model-text.ts` renderNotification）：`<summary>` 已是人话
  const notification = text.match(/^<task-notification>\n?([\s\S]*?)\n?<\/task-notification>$/);
  if (notification) {
    const body = notification[1] ?? '';
    return presentNotice({
      source: 'task_notification',
      text: body,
      summary: body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || undefined,
    });
  }

  return undefined;
}

// ==================== 出口 ====================

export function presentUserMessage(
  subtype: MessageSubtype,
  rawText: string,
): MessagePresentation {
  const override = envelopeOverride(rawText);
  if (override) return override;

  const fallback = BY_SUBTYPE[subtype];
  return fallback.as === 'user'
    ? { as: 'user', origin: fallback.origin, text: rawText }
    : presentNotice({ source: subtype, text: rawText });
}
