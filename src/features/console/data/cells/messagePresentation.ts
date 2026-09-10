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
 * 2. 系统记录再按信封来源区分外部发言、父流程消息和系统通知；用户原文保持原样。
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
      readonly summary?: string | PresentationText;
      readonly titleKey: string;
      readonly tone: TranscriptTone;
      readonly badge?: TranscriptBadge;
      readonly defaultExpanded: boolean;
      readonly eventType?: SubagentEventType;
      readonly errorType?: string;
      readonly metadata?: readonly PresentationText[];
      readonly detailFile?: string;
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
  titleKey: 'transcript.systemEvent.message',
  tone: 'neutral',
  defaultExpanded: false,
};

const SYSTEM_NOTICE_STYLES = {
  worker_interrupted: { titleKey: 'transcript.systemEvent.workerInterrupted', tone: 'warning', defaultExpanded: false },
  closure_check: { titleKey: 'transcript.systemEvent.closureCheck', tone: 'muted', defaultExpanded: false },
  session_restored: { titleKey: 'transcript.systemEvent.sessionRestored', tone: 'neutral', defaultExpanded: false },
  system_reminder: { titleKey: 'transcript.systemEvent.reminder', tone: 'muted', defaultExpanded: false },
  task_notification: { titleKey: 'transcript.systemEvent.backgroundTask', tone: 'neutral', defaultExpanded: false },
} as const satisfies Record<string, NoticeStyle>;

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
  readonly summary?: string | PresentationText;
  readonly eventType?: SubagentEventType;
  readonly errorType?: string;
  readonly metadata?: readonly PresentationText[];
  readonly detailFile?: string;
  readonly style?: NoticeStyle;
}

function presentNotice(input: NoticeInput): NoticeMessagePresentation {
  const style = input.style ?? (input.eventType
    ? SUBAGENT_NOTICE_STYLES[input.eventType]
    : Object.hasOwn(SYSTEM_NOTICE_STYLES, input.source)
      ? SYSTEM_NOTICE_STYLES[input.source as keyof typeof SYSTEM_NOTICE_STYLES]
      : DEFAULT_NOTICE_STYLE);
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
    ...(input.detailFile && { detailFile: input.detailFile }),
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

function readableParentEventText(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;

  const envelope = parsed as Record<string, unknown>;
  if (envelope.storage === 'inline') {
    const data = envelope.data;
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const message = (data as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
  }
  if (envelope.storage === 'file' && typeof envelope.summary === 'string') {
    return envelope.summary;
  }
  return body;
}

/**
 * 系统来源保留通知归属；父流程与外部发言只展示可读正文。
 */
function externalOverride(source: string, body: string): MessagePresentation {
  if (source === 'system' || source === 'module' || source === 'browser' || source === 'subagent') {
    return systemNoticeOverride(body.trim()) ?? presentNotice({ source, text: body });
  }
  const fromParent = source.startsWith('parent');
  return {
    as: 'user',
    origin: fromParent ? 'parent' : 'user',
    text: fromParent ? readableParentEventText(body) : body,
  };
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

function eventMetadata(attributes: string): PresentationText[] {
  const fields = [
    ['origin', 'transcript.meta.origin'],
    ['provider', 'transcript.meta.provider'],
    ['model', 'transcript.meta.model'],
    ['request_id', 'transcript.meta.requestId'],
    ['trace_id', 'transcript.meta.traceId'],
  ] as const;
  const metadata: PresentationText[] = [];
  for (const [attributeName, messageKey] of fields) {
    const value = attribute(attributes, attributeName);
    if (!value) continue;
    metadata.push(messageText(messageKey, { value: rawText(value) }));
  }
  return metadata;
}

interface ParsedSubagentEventBody {
  readonly text: string;
  readonly summary?: string;
  readonly detailFile?: string;
}

/** 文件型 ATA 载荷由后端渲染为 summary/detail；在展示边界还原为可读内容。 */
function parseSubagentEventBody(body: string): ParsedSubagentEventBody {
  const fileBody = body.match(
    /^<summary>([\s\S]*?)<\/summary>\n<detail\b([^>]*)\/?>[^\n]*$/,
  );
  if (!fileBody) return { text: body };

  const summary = (fileBody[1] ?? '').trim();
  const detailFile = attribute(fileBody[2] ?? '', 'path');
  if (!summary || !detailFile) return { text: body };
  return { text: summary, summary, detailFile };
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
    const bodyPresentation = parseSubagentEventBody(body);
    return presentNotice({
      source,
      text: bodyPresentation.text,
      summary: bodyPresentation.summary,
      detailFile: bodyPresentation.detailFile,
      eventType,
      errorType,
      metadata: eventMetadata(attributes),
    });
  }

  return systemNoticeOverride(text);
}

function systemNoticeOverride(text: string): NoticeMessagePresentation | undefined {
  const interrupted = text.match(/^<worker_interrupted>\s*([\s\S]*?)\s*<\/worker_interrupted>$/);
  if (interrupted) {
    return presentNotice({
      source: 'worker_interrupted',
      text: interrupted[1] ?? '',
      summary: messageText('transcript.systemEvent.workerInterruptedSummary'),
    });
  }

  const closure = text.match(/^<closure_check\b[^>]*>\s*([\s\S]*?)\s*<\/closure_check>$/)
    ?? text.match(/^<closure_check\b[^>]*\/>\n?([\s\S]*)$/);
  if (closure) {
    return presentNotice({
      source: 'closure_check', text: closure[1] ?? '',
      summary: messageText('transcript.systemEvent.closureCheckSummary'),
    });
  }

  const reminder = text.match(/^<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>$/);
  if (reminder) return presentNotice({ source: 'system_reminder', text: reminder[1] ?? '' });

  // 后台任务完成通知（`model-text.ts` renderNotification）：`<summary>` 已是人话
  const notification = text.match(/^<task-notification>\n?([\s\S]*?)\n?<\/task-notification>$/);
  if (notification) {
    const body = notification[1] ?? '';
    const fields = body.match(/^<task-id>([\s\S]*?)<\/task-id>\n<output-file>([\s\S]*?)<\/output-file>\n<status>([\s\S]*?)<\/status>\n<summary>([\s\S]*?)<\/summary>\n<tail>([\s\S]*)<\/tail>$/);
    if (!fields) return presentNotice({ source: 'task_notification', text: body });
    const detailFile = fields[2]?.trim();
    const status = fields[3]?.trim();
    const summary = fields[4]?.trim();
    const tail = fields[5]?.trim();
    const titleKey = status === 'ok' ? 'transcript.systemEvent.backgroundCompleted'
      : status === 'failed' ? 'transcript.systemEvent.backgroundFailed'
        : status === 'killed' ? 'transcript.systemEvent.backgroundStopped'
          : 'transcript.systemEvent.backgroundTask';
    return presentNotice({
      source: 'task_notification',
      text: [summary, tail].filter(Boolean).join('\n\n'),
      summary,
      detailFile,
      style: {
        titleKey,
        tone: status === 'failed' ? 'danger' : status === 'killed' ? 'warning' : 'neutral',
        defaultExpanded: false,
      },
    });
  }

  return undefined;
}

// ==================== 出口 ====================

export function presentUserMessage(
  subtype: MessageSubtype,
  rawText: string,
  messageId?: string,
): MessagePresentation {
  const fallback = BY_SUBTYPE[subtype];
  if (fallback.as === 'user') return { as: 'user', origin: fallback.origin, text: rawText };

  const override = envelopeOverride(rawText);
  if (override) return override;

  // AgentService 的恢复通知使用稳定记录 ID，正文仍是普通文本。
  if (subtype === 'system_event' && messageId?.startsWith('worker-interruption:')) {
    return presentNotice({
      source: 'session_restored', text: rawText,
      summary: messageText('transcript.systemEvent.sessionRestoredSummary'),
    });
  }
  return presentNotice({ source: subtype, text: rawText });
}
