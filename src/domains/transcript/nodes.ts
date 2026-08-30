/**
 * Transcript node contract shared by every Console presenter.
 *
 * 三条约束：
 * 1. **判别联合**：以 `kind` 判别，谁配谁由类型保证；不是"一个平坦结构 + 一堆可选字段"。
 * 2. **构建期冻结**：titleKey / tone / summary / meta 在 projection 时算完；标题由 presenter 翻译。
 *    唯一例外是 `detail` —— 它是 thunk，折叠态永不求值。
 * 3. **纯数据**：本文件零运行时 import。动作是描述符而非闭包，因此会话投影可以是纯函数
 *    `import type` 编译期擦除，不违反该约束
 *    ——`ToolCellArtifact` 引用 `LineDiff`（含 Token），在此复制形状才是漂移源。
 */

import type { ToolCellArtifact } from '@/features/console/data/toolArtifacts';
import type { CellMedia } from '@/features/console/data/cells/media';
import type { PresentationText } from '@/features/console/data/presentationText';

// ==================== 基础标量 ====================

/** cell 的稳定身份：用于列表 key、滚动定位、byToolUseId 配对 */
export type TranscriptNodeId = string;

/**
 * 语义色阶。落到 tokens.css 的 status-* / surface-* 由 presenter 决定，
 * 数据层不出现任何色值（四套并行词汇收敛为这一套）。
 */
export type TranscriptTone = 'neutral' | 'live' | 'warning' | 'danger' | 'muted';

/** 条目的交互形态。`preview` 专指重开 diff 抽屉（待确认的写入类工具） */
export type TranscriptInteraction = 'none' | 'expand' | 'modal' | 'preview';

/**
 * 状态徽章用语义键而非文案：presenter 负责映射文字。
 * i18n 虽本版延后，但不把文案沉到数据层，避免将来还得再挖一遍。
 */
export type TranscriptBadge = 'running' | 'awaiting-approval' | 'failed' | 'cancelled';

// ==================== 详情（thunk 求值） ====================

export type DetailFormat = 'text' | 'code' | 'json' | 'markdown' | 'question_answers' | 'audio_blocks';

export interface DetailSection {
  readonly value: unknown;
  readonly format: DetailFormat;
}

export interface TranscriptDetail {
  readonly sections: readonly DetailSection[];
}

// ==================== 媒体与附件 ====================

export interface TranscriptFileRef {
  readonly name: string;
  readonly path: string;
}

// ==================== 动作描述符 ====================

/**
 * 目前唯一的动作是"把仍在前台等待的可后台化工具移交 BackgroundRegistry"
 * （`tool:promote-to-background`）。
 *
 * 是**描述符不是闭包**：会话投影因此不依赖 IPC，可作为纯函数直接测试。
 * presenter 把 kind 映射为图标/文案/handler；shortcut 由焦点面板的键盘路由分派。
 */
export type TranscriptActionKind = 'promote-to-background';

export interface TranscriptAction {
  readonly kind: TranscriptActionKind;
  /** 形如 'mod+b'；由焦点面板独占分派，非焦点面板不响应 */
  readonly shortcut?: string;
  /**
   * 目前恒为 true——点下去才知道该工具是否支持后台化。
   * 后端补"可后台化"标志后在 toolCell.ts 一处收紧。
   */
  readonly enabled: boolean;
  readonly callId: string;
}

// ==================== 工具状态机 ====================

/**
 * 五态互斥。判据优先序：
 * 待审批 → 无结果条目=执行中 → 持久结果的 ok/内容判定。
 */
export type ToolState =
  | { readonly phase: 'running' }
  | { readonly phase: 'awaiting-approval'; readonly callId: string }
  | { readonly phase: 'ok' }
  | { readonly phase: 'failed'; readonly error: string }
  | { readonly phase: 'cancelled'; readonly reason?: PresentationText };

// ==================== TranscriptNode ====================

/** 所有 cell 共有的字段 */
interface TranscriptNodeBase {
  readonly id: TranscriptNodeId;
  /**
   * 原始毫秒时间戳。**不在数据层格式化**——一旦在解析期冻结成 locale 字符串，
   * 切换语言/时区就必须重建全部 cell。格式化交给 presenter。
   */
  readonly ts: number;
  /**
   * 来源 ConversationEntry 的行号；-1 表示尚未落盘（live tail）。
   * TranscriptSession 用它对齐分页窗口与"向上加载更多"。
   */
  readonly sourceIndex: number;
  /** Locale-neutral title descriptor. Presenters resolve it without rebuilding projection. */
  readonly titleKey: string;
  readonly titleArgs?: Readonly<Record<string, string | number>>;
  /** 折叠态显示的一行摘要；原始事实与产品文案在类型上分开。 */
  readonly summary?: PresentationText;
  /** 次级 meta 轨（工具名、图片/文件计数、模型、cache…）。时间戳不在其中，由 presenter 从 ts 渲染 */
  readonly meta?: readonly PresentationText[];
  readonly tone: TranscriptTone;
  readonly interaction: TranscriptInteraction;
  /** 策略性默认展开（AI 回复、待确认的计划正文、移动端动作工具） */
  readonly defaultExpanded: boolean;
  /** 展开后是否隐藏摘要行——摘要与某段 readable 详情重复时隐藏，避免同一句话出现两遍 */
  readonly summaryDuplicatesDetail: boolean;
  /** 构建期求值；折叠态不调用 */
  readonly detail?: () => TranscriptDetail;
}

/** 用户消息 / 任务分配 / 来自主流程的事件——三者结构相同，用 origin 区分 */
export interface UserNode extends TranscriptNodeBase {
  readonly kind: 'user';
  readonly origin: 'user' | 'assignment' | 'parent';
  readonly text?: string;
  readonly images?: readonly CellMedia[];
  readonly files?: readonly TranscriptFileRef[];
}

/** AI 面向用户的回复正文；reasoning 由相邻 ThinkNode 独立呈现。 */
export interface AssistantNode extends TranscriptNodeBase {
  readonly kind: 'assistant';
  readonly markdown: string;
  readonly live: boolean;
}

/** Provider 公开返回、允许展示的 reasoning text/summary。 */
export interface ThinkNode extends TranscriptNodeBase {
  readonly kind: 'think';
  readonly markdown: string;
  readonly live: boolean;
}

/**
 * 文件操作载荷（`read` / `write` / `edit` 三个工具）。
 *
 * 类型定义在本文件而非 `fileOp.ts`，是为了守住文件头第 3 条"零 import"：
 * `ToolNode` 引它，它若定义在别处就得从这里 import 回去。抽取逻辑仍在 `fileOp.ts`。
 */
export type FileOp =
  | {
      readonly kind: 'edit';
      readonly path: string;
      readonly oldText: string;
      readonly newText: string;
      readonly replaceAll: boolean;
    }
  | { readonly kind: 'write'; readonly path: string; readonly content: string }
  | {
      readonly kind: 'read';
      readonly path: string;
      /** 文本文件：去掉行号前缀后的内容 */
      readonly content?: string;
      /** 内容首行在文件中的真实行号（来自 read 的行号前缀） */
      readonly startLine?: number;
      /** 读取失败 / 不可预览（二进制、超大…）时的原文说明 */
      readonly unreadable?: PresentationText;
    };

export interface ToolNode extends TranscriptNodeBase {
  readonly kind: 'tool';
  /** 后端工具名原样（如 `read` / `browser_takeScreenshot`），用于诊断与 meta */
  readonly tool: string;
  readonly state: ToolState;
  readonly badge?: TranscriptBadge;
  readonly media?: readonly CellMedia[];
  readonly actions: readonly TranscriptAction[];
  /**
   * 文件操作载荷（只有 `read`/`write`/`edit` 有）。
   * thread 右栏「审阅」面板据此渲染 diff / 文件内容；其余模式忽略即可。
   */
  /**
   * 生图成功落盘的绝对路径（`generate_image` 且 phase ok 才有）。
   *
   * 从**结果文本**的 `- [成功] <path>` 行解析（`generate-image.tool.ts:197` 的固定格式），
   * 不用 params —— params 是"请求了什么"，partial 时会把失败路径也当成品展示。
   * 结果文本随会话记录持久化，所以这个观看面在历史会话里也成立——
   * 流水尾部的审核块只活到 imageNode 结算为止。
   */
  readonly generatedImages?: readonly string[];
  readonly fileOp?: FileOp;
  /**
   * 持久 artifact 的投影结果：buildToolNode 调用一次
   * `projectToolArtifacts()` 挂上；`review` slot 供 fileChangeOf 取权威 diff，
   * `tool-detail` slot 已折进 detail sections。可丢弃派生数据，可从 ToolEntry 重建。
   */
  readonly artifacts?: readonly ToolCellArtifact[];
}

/** 上下文压缩摘要 */
export interface SummaryNode extends TranscriptNodeBase {
  readonly kind: 'summary';
  readonly compactionId: string;
  readonly preview: string;
}

/** 计划提交：正文就地阅读，审批门由 gate 承载 */
export interface PlanNode extends TranscriptNodeBase {
  readonly kind: 'plan';
  readonly taskSummary: string;
  readonly body?: string;
  /** 待确认时携带 callId，供 Gate 配对；终态为 undefined */
  readonly pendingCallId?: string;
}

/** 子流程创建 */
export interface WorkerNode extends TranscriptNodeBase {
  readonly kind: 'worker';
  readonly workerId: string;
  readonly subject: string;
  readonly mode: string;
  readonly taskIds: readonly string[];
}

/** 子流程事件 / 回合收尾提醒等系统提示 */
export interface NoticeNode extends TranscriptNodeBase {
  readonly kind: 'notice';
  readonly source: string;
  readonly text: string;
  readonly eventType?: string;
  readonly errorType?: string;
  readonly badge?: TranscriptBadge;
}

export type TranscriptNode =
  | UserNode
  | AssistantNode
  | ThinkNode
  | ToolNode
  | SummaryNode
  | PlanNode
  | WorkerNode
  | NoticeNode;

export type TranscriptNodeKind = TranscriptNode['kind'];
