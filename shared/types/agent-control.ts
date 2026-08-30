/**
 * Agent 控制状态与存储类型
 * AgentRun 持久 Header 与当前 Runtime 控制投影。
 */

import type {
  ApprovalMode,
  AgentModeId,
  PendingToolCall,
  AIQuestion,
  AgentRunConfig,
  SubagentMode,
  SubagentConfig,
  ContentBlock,
  ToolResultContentBlock,
  MessageSubtype,
  AIRequestState,
  TaskItem,
  ImageNodePublicState,
  AgentInputSource,
} from './index.js';
import type { ContextSummary } from './context.js';
import type { ContextUsage } from './token.js';
import type { ReasoningSelection } from './reasoning.js';
import type { ToolArtifact } from './tool-artifact.js';
import type { ImageRefBlock } from './image-resource.js';
import type { AgentMcpView } from './mcp.js';

/** Canonical address for a top-level AgentRun or one of its Workers. */
export interface AgentTarget {
  readonly agentId: string;
  readonly workerId?: string;
}

// ============================================================
// 运行时类型（不存储，仅在 runtime 推送）
// ============================================================

export type AgentPhase = 'thinking' | 'executing' | 'waiting' | 'stopping';

export type MetricCoverage = 'none' | 'partial' | 'complete';

export interface AgentRunMetrics {
  version: 1;
  rounds: number;
  steps: number;
  llmDurationMs: number;
  toolDurationMs: number;
  firstVisibleContentLatencyTotalMs: number;
  firstVisibleContentSamples: number;
  generationDurationMs: number;
  generationOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  coverage: {
    toolTiming: MetricCoverage;
    firstVisibleContent: MetricCoverage;
    throughput: MetricCoverage;
    inputTokens: MetricCoverage;
    outputTokens: MetricCoverage;
    cacheReadTokens: MetricCoverage;
  };
}

export interface AgentActivityState {
  activeStartedAt?: number;
  activeLlmStartedAt?: number;
  activeToolPhaseStartedAt?: number;
  runMetrics: AgentRunMetrics;
}

/** Mailbox 中尚未消费的事件投影；只供运行时界面展示，不进入持久化。 */
export interface PendingAgentEventView {
  readonly id: string;
  readonly timestamp: number;
  readonly source: AgentInputSource;
  readonly content: string | Record<string, unknown>;
  readonly priority?: 'high' | 'normal' | 'low';
  /** 仅暴露数量，控制状态不携带图片 base64。 */
  readonly imageCount: number;
}

// ============================================================
// 产品出口谓词（单一来源，UI 只消费谓词、不手写 phase 布尔）
// ============================================================

/**
 * 停止出口：活跃会话恒可停止——stopping 也不例外。
 * 停止是幂等出口，卡在 stopping 的会话恰恰最需要它可见。
 */
export function canStop(_state: { phase: AgentPhase }): boolean {
  return true;
}

type PausableState = { phase: AgentPhase; pendingQuestion?: unknown };

function isBusy(state: PausableState): boolean {
  return state.phase === 'thinking'
    || state.phase === 'executing'
    || (state.phase === 'waiting' && state.pendingQuestion !== undefined);
}

/** 暂停/中断出口：自身或任一子代理运行中/等待用户输入。 */
export function canPause(
  state: PausableState & { children?: ReadonlyArray<PausableState> },
): boolean {
  if (state.phase === 'stopping') return false;
  return isBusy(state) || (state.children ?? []).some(isBusy);
}

/** 已中断稳态，只用于控制状态可见性与派生。 */
export function isInterrupted(state: { interrupted?: boolean }): boolean {
  return state.interrupted === true;
}

/** 整树级联计主一个；仅子被单独中断时才逐个计子。 */
export function collectInterruptedTargets(
  agents: ReadonlyArray<{
    agentId: string;
    interrupted?: boolean;
    children?: ReadonlyArray<{ id: string; interrupted?: boolean }>;
  }>,
): Array<{ kind: 'main' | 'child'; id: string }> {
  const targets: Array<{ kind: 'main' | 'child'; id: string }> = [];
  for (const agent of agents) {
    if (isInterrupted(agent)) {
      targets.push({ kind: 'main', id: agent.agentId });
      continue;
    }
    for (const child of agent.children ?? []) {
      if (isInterrupted(child)) targets.push({ kind: 'child', id: child.id });
    }
  }
  return targets;
}

/**
 * Agent 控制状态 — 小型、频繁推送。
 * 只为已加载（在跑）的会话推送；出现在前端 store 即代表在跑。
 * 历史会话的展示态由 header + conversation 独立构建，不进入 store 的 controlStates。
 */
export interface AgentControlState extends AgentActivityState {
  agentId: string;
  phase: AgentPhase;
  /** 用户中断稳态；任一成功 post 同步清除。 */
  interrupted?: boolean;
  currentModel: string;
  /** 本次活跃运行从模型配置取得的会话级快照。 */
  reasoningOverride: ReasoningSelection;
  approvalMode: ApprovalMode;
  modeId: AgentModeId;
  pendingToolCall?: PendingToolCall;
  pendingQuestion?: AIQuestion;
  /** AgentMailbox 当前 FIFO 队列的只读投影。 */
  pendingEvents: PendingAgentEventView[];
  /** AI 请求瞬时状态（权威真相源；UI 从此渲染，不从 AgentIncident 推断） */
  aiRequestState?: AIRequestState;
  contextUsage?: ContextUsage;
  conversationLength: number;
  children: ChildControlState[];
  agentSpec: string;
  runConfig: AgentRunConfig;
  createdAt: string;
  /** 当前共享任务看板；tasks.json 内容的可丢弃 UI 投影。 */
  taskBoard?: { taskSummary: string; items: TaskItem[] };
  /** 生图审核节点投影（getControlState 每次从 ImageModule 即时派生，轻量路径状态，不带 base64） */
  imageNodes?: ImageNodePublicState[];
  /** 当前 Main 独占 MCP Session Runtime 的可丢弃只读投影。 */
  mcp?: AgentMcpView;
}

/**
 * 子 Agent 控制状态。
 * 存在于 children 数组中 = 在跑。
 */
export interface ChildControlState extends AgentActivityState {
  id: string;
  phase: AgentPhase;
  interrupted?: boolean;
  mode: SubagentMode;
  /** Parent UI 使用的 Assignment 简短标题 */
  subject: string;
  /** 创建期 Assignment 引用的细任务 ID；仅用于从 Main 权威看板派生 Worker UI。 */
  taskIds: string[];
  browserReady: boolean;
  currentModel: string;
  approvalMode: ApprovalMode;
  /** Created from the parent run snapshot and independently mutable afterwards. */
  reasoningOverride: ReasoningSelection;
  pendingToolCall?: PendingToolCall;
  /** Worker Mailbox 当前 FIFO 队列的只读投影。 */
  pendingEvents: PendingAgentEventView[];
  /** AI 请求瞬时状态（main/child 暴露同一权威状态） */
  aiRequestState?: AIRequestState;
  contextUsage?: ContextUsage;
  conversationLength: number;
  browserId?: string;
  skills?: string[];
  /** 生图审核节点投影（Worker 图片节点连接到对应 Worker） */
  imageNodes?: ImageNodePublicState[];
  /** 当前 Worker 独占 MCP Session Runtime 的可丢弃只读投影。 */
  mcp?: AgentMcpView;
}

// ============================================================
// 存储类型（持久化到磁盘）
// ============================================================

/**
 * Agent 头信息 — 纯元信息快照（无运行状态）。
 * childAgents 是当前可恢复 Worker 清单：创建成功前加入、单个 Worker
 * 正常退出后移除；应用整体退出时保留，供下次恢复报告中断。
 * JSONL marker 仅保留历史审计与 Worker ID 计数，不重建 Worker 运行态。
 */
export interface AgentRunHeader {
  agentId: string;
  agentSpec: string;
  modeId: AgentModeId;
  runConfig: AgentRunConfig;
  createdAt: string;
  lastActiveAt: string;
  currentModel: string;
  approvalMode: ApprovalMode;
  childAgents: ChildSnapshot[];
}

export interface ChildSnapshot {
  id: string;
  config: SubagentConfig;
  createdAt: number;
}

export type { ImageRefBlock } from './image-resource.js';

export interface TextBlock {
  type: 'text';
  text: string;
}

/** Canonical ToolEntry.result never contains inline image bytes. */
export type PersistedToolResultBlock = TextBlock | ImageRefBlock;

type PersistedPlainMessageBlockType = Exclude<ContentBlock['type'], 'image' | 'tool_result'>;
type PersistedPlainMessageBlock = {
  [T in PersistedPlainMessageBlockType]: Omit<ContentBlock, 'type' | 'content' | 'source'> & {
    type: T;
    content?: never;
    source?: never;
  }
}[PersistedPlainMessageBlockType];

type PersistedToolResultMessageBlock = Omit<ContentBlock, 'type' | 'content' | 'source'> & {
  type: 'tool_result';
  content?: string | PersistedToolResultBlock[];
  source?: never;
};

/** Canonical MsgEntry block shape after ConversationStore externalization. */
export type PersistedMessageBlock =
  | PersistedPlainMessageBlock
  | PersistedToolResultMessageBlock
  | ImageRefBlock;

/**
 * JSONL 对话条目 — 替代 SessionData
 * 每行一个 JSON 对象，appendFileSync 写入。
 */
export type ConversationEntry =
  | MsgEntry
  | ToolEntry
  | SummaryEntry
  | MarkerEntry;

/** Runtime entry accepted by ConversationStore before image externalization. */
type RuntimeMessageEntry<T extends MsgEntry = MsgEntry> = T extends MsgEntry
  ? Omit<T, 'content'> & { content: string | ContentBlock[] }
  : never;

export type ConversationWriteEntry =
  | RuntimeMessageEntry
  | (Omit<ToolEntry, 'result' | 'artifacts'> & {
      result: ToolResultContentBlock[];
      artifacts?: ToolArtifact[];
    })
  | SummaryEntry
  | MarkerEntry;

interface MsgEntryBase {
  t: 'msg';
  ts: number;
  id: string;
  content: string | PersistedMessageBlock[];
}

export interface UserMsgEntry extends MsgEntryBase {
  role: 'user';
  subtype: MessageSubtype;
}

export interface AssistantMsgEntry extends MsgEntryBase {
  role: 'assistant';
  subtype?: never;
}

export type MsgEntry = UserMsgEntry | AssistantMsgEntry;

export interface ToolEntry {
  t: 'tool';
  ts: number;
  toolUseId: string;
  result: PersistedToolResultBlock[];
  ok: boolean;
  /**
   * 持久 UI 产物：仅前端 projector 消费，replay/模型上下文永不读取。
   * 无产物时省略字段（不写空数组）。
   */
  artifacts?: ToolArtifact[];
}

export interface SummaryEntry {
  t: 'summary';
  ts: number;
  summary: ContextSummary;
}

export interface MarkerEntry {
  t: 'marker';
  ts: number;
  key: string;
  value: unknown;
}

/** Metadata that accompanies a write-before-emit append but is never serialized. */
export interface ConversationAppendMetadata {
  requestId?: string;
}

/**
 * 对话追加推送（tail -f）— 每条条目写盘成功后携带行号推送给前端。
 * index 是可解析条目的序号（从 0 开始），与 readFrom 的 offset 同一定义。
 */
export interface ConversationAppendEvent {
  agentId: string;
  index: number;
  entry: ConversationEntry;
  /** Runtime-only correlation for replacing the matching live response. */
  requestId?: ConversationAppendMetadata['requestId'];
}
