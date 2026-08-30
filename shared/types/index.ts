/**
 * PISKIE 共享类型定义
 * 主进程和渲染进程共用
 */

import type {
  AgentRunBindings,
  StandardTaskBindings,
} from './task-bindings.js';
import type { AIRequestInfo } from './context.js';
import type { AIErrorType } from '../constants/index.js';
export type { AgentRunBindings, StandardTaskBindings } from './task-bindings.js';
export type {
  ReasoningEffort,
  ReasoningSelection,
  ReasoningTransportPreset,
  ReasoningProfile,
} from './reasoning.js';
export type {
  CatalogProviderId,
  CapabilityState,
  ModelLifecycle,
  ModelTag,
  ModelCapabilityProfile,
  CatalogProvenance,
  ModelPricing,
} from './model-catalog.js';
export type { SetupGuideStep, SetupGuide } from './setup-guide.js';
export { projectDisplayName, type ProjectRecord } from './project.js';
export type {
  FileDiffArtifactStat,
  ToolArtifact,
  ToolArtifactKind,
  ToolArtifactMap,
  ToolArtifactOf,
} from './tool-artifact.js';
export type {
  ModelTarget,
  OpenAiWireApi,
  PlainInferenceAuth,
  InferenceModelBinding,
  InferenceProviderInstance,
  InferenceConfig,
  InferenceSelections,
  InferenceModelCapabilities,
  InferenceModelDefinition,
  InferenceCatalogModelInput,
  InferenceLocalCatalogDocument,
  InferenceModelQueryResult,
  InferenceDriverSummary,
  InferenceDriverSchema,
  InferenceComfyFieldBinding,
  InferenceComfyWorkflowAsset,
  InferenceComfyWorkflowInspection,
  InferenceComfyWorkflowBindingCandidates,
  InferenceComfyWorkflowBindingReport,
  InferenceProbeReceipt,
  InferenceImageArtifact,
  InferenceArtifactPreview,
} from './inference.js';
export type {
  ConfigCapability,
  ConfigFieldMutability,
  ConfigFieldBindingDescriptor,
  ConfigFieldDescriptor,
  ConfigExtensionSelector,
  ConfigExtensionSchemaDescriptor,
  ConfigDynamicExtensionDescriptor,
  ConfigDescriptor,
  ConfigDomainAvailabilityState,
  ConfigDomainLifecycleStage,
  ConfigDomainAvailabilityIssue,
  ConfigDomainAvailability,
  ConfigDomainSummary,
  ConfigPatchOperation,
  ConfigFieldChange,
  ConfigPlanRequest,
  ConfigPlanIdentity,
  ConfigPlan,
  ConfigVerificationReport,
  ConfigProbeRequest,
  ConfigApplyReceipt,
  ConfigChangeSource,
  ConfigDomainRevisionChangedEvent,
} from './config.js';
export type { AIRequestInfo } from './context.js';

// ============================================================
// 新架构类型（doc 20 + doc 21）
// ============================================================
import type { AgentControlState as _AgentControlState } from './agent-control.js';
export type {
  AgentTarget,
  AgentPhase,
  AgentControlState,
  ChildControlState,
  AgentRunHeader,
  ChildSnapshot,
  ImageRefBlock,
  TextBlock,
  ConversationEntry,
  ConversationWriteEntry,
  MsgEntry,
  PersistedMessageBlock,
  PersistedToolResultBlock,
  ToolEntry,
  MetricCoverage,
  AgentRunMetrics,
  AgentActivityState,
  PendingAgentEventView,
  SummaryEntry,
  MarkerEntry,
  ConversationAppendMetadata,
  ConversationAppendEvent,
} from './agent-control.js';

// 占用登记类型
export type {
  OccupancyKind,
  Occupancy,
  ClaimRequest,
  ClaimResult,
} from './occupancy.js';
export { occupancyKey } from './occupancy.js';

// 浏览器环境归属策略

// ============================================================
// AI 相关类型
// ============================================================

/**
 * 消息子类型 - 区分不同来源的消息
 */
export type MessageSubtype =
  | 'user_input'            // 真正的用户输入
  | 'system_task'           // 系统任务描述（runConfig.promptTemplate）
  | 'assignment'            // Worker 创建期唯一 Assignment + 紧凑 Task Board
  | 'system_event'          // 系统事件（initial_start、定时唤醒）
  | 'subagent_notification' // 子流程通知
  | 'context_summary';      // 上下文压缩摘要

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  subtype?: MessageSubtype;  // 消息子类型，仅 user 消息使用
}

export interface OpenAiReasoningSummaryBlock {
  type: 'summary_text';
  text: string;
}

export interface OpenAiReasoningContentBlock {
  type: 'reasoning_text';
  text: string;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking' | 'redacted_thinking' | 'openai_reasoning';
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  protocol?: 'openai-chat';
  summary?: OpenAiReasoningSummaryBlock[];
  reasoning_content?: OpenAiReasoningContentBlock[];
  encrypted_content?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  id?: string;
  name?: string;
  input?: unknown;
  provider_item_id?: string;
  tool_use_id?: string;
  content?: string | ToolResultContentBlock[];
  /** Anthropic tool_result failure signal, derived from the persisted ToolEntry.ok field. */
  is_error?: boolean;
  /** Image source (for type='image') */
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Tool result 内容块（支持多模态）
 */
export interface ToolResultContentBlock {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface ToolInputSchema extends Record<string, unknown> {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  oneOf?: Array<Record<string, unknown>>;
  anyOf?: Array<Record<string, unknown>>;
  allOf?: Array<Record<string, unknown>>;
  additionalProperties?: boolean | Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export type AIStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'content_filter' | 'other';

export interface AIResponse {
  content: ContentBlock[];
  requestInfo: AIRequestInfo;
}

/**
 * 工具调用确认模式
 * - 'auto': 自动批准所有工具调用
 * - 'confirm': 每次工具调用需要用户确认
 */
export type ApprovalMode = 'auto' | 'confirm';

/**
 * 顶层 Agent 模式
 * - 'normal': 普通模式，不强制做计划
 * - 'plan': 计划模式，必须先制定计划并获得用户审批
 * - 'browser-skill': 网站 Skill 构建模式
 */
export type AgentModeId = string;

/**
 * ask_user 单个问题项（一次调用可携带多个问题）
 */
export interface AIQuestionItem {
  /** 问题内容（已 trim，非空） */
  question: string;
  /** 预设选项（可选，用户也可以自由输入） */
  options?: string[];
  /** 是否支持多选（默认 false，单选使用按钮，多选使用复选框） */
  multiSelect: boolean;
}

/**
 * AI 向用户提出的问题快照（从尾部未配对 ask_user tool_use 纯派生，非权威状态）
 */
export interface AIQuestion {
  /** = 发起提问的 ask_user tool_use ID（问题身份唯一来源，不再有随机 questionId） */
  id: string;
  /** 发起提问的 Agent ID */
  agentId: string;
  /** 问题列表（长度 ≥ 1，来自 tool_use.input.questions） */
  questions: AIQuestionItem[];
  /** 快照生成时间戳 */
  timestamp: Date;
}

/**
 * 预览信息（用于 dryRun 模式）
 */
export interface PreviewInfo {
  /** 预览类型 */
  type: 'diff' | 'command' | 'text';
  /** 预览标题 */
  title: string;
  /** 预览内容（diff 文本、命令等） */
  content: string;
  /** 统计信息（可选） */
  stat?: {
    linesAdded?: number;
    linesDeleted?: number;
    linesChanged?: number;
  };
}

/**
 * 待确认的工具调用
 */
export interface PendingToolCall {
  /** 唯一 ID */
  id: string;
  /** 发起调用的 Agent ID */
  agentId: string;
  /** 所属顶层 Agent ID */
  mainAgentId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具参数 */
  params: Record<string, unknown>;
  /** 请求时间戳 */
  timestamp: Date;
  /** 人类可读的操作描述 */
  description: string;
  /** 工具分类（用于 UI 展示） */
  category: 'document' | 'agent' | 'browser' | 'system' | 'local';
  /** 预览信息（dryRun 模式下的预览内容） */
  preview?: PreviewInfo;
  /** 工作流确认不受工具 Auto 模式影响，例如计划正文批准。 */
  modeInvariant?: boolean;
}

/**
 * 用户对工具调用的决策
 */
export interface ToolApprovalDecision {
  /** 待确认调用的 ID */
  callId: string;
  /** 用户决策 */
  decision: 'allow' | 'deny';
  /** 拒绝原因（可选） */
  reason?: string;
  /** 用户反馈内容（传给 AI，用于调整后续行为） */
  feedback?: string;
  /** 统一工具门的 allow 决策可同时把当前 Agent 切换到 Auto。 */
  changeToAuto?: boolean;
  /** 附带的图片（base64） */
  images?: Array<{ data: string; media_type: string }>;
}

/**
 * 子流程模式: browser(浏览器) / local(本地)
 * AI 必须显式传递模式
 */
export type SubagentMode = 'browser' | 'local';

/**
 * 子流程创建配置
 * 统一的 Subagent 可同时使用固定 Skill 工具（如 browser_*）和本地原生工具。
 */
export interface SubagentConfig {
  /** 子流程模式: browser(浏览器) / local(本地)。AI 必须传递。 */
  mode: SubagentMode;
  /** 整个 Assignment 的简短显示标题 */
  subject: string;
  /** 本次 Assignment 包含的细任务 ID */
  taskIds: string[];
  /** 整个多任务工作包的完整、自包含执行标准 */
  prompt: string;
  /** 需要加载的技能列表（可选，加载对应工具和文档） */
  skills?: string[];
  /** Runtime AgentSpec override supplied by the trusted parent runtime. */
  agentSpec?: string;
  /** Browser 模式下绑定的环境 ID（仅 boundEnvironmentIds 非空时可用） */
  browserEnvironmentId?: string;
  /** Worker-specific settings; never mutate the parent run snapshot. */
  advancedSettings?: TaskAdvancedSettings;
}

/**
 * 子流程通知 director
 * 特殊类型与 send_event 的 type enum 一致；省略 type 的普通消息归一化为 message。
 */
export interface SubagentFailure {
  /** 来自统一 AI 错误映射；消费方不得通过错误文案反推类型。 */
  errorType: AIErrorType;
  /** 已脱敏的 provider 诊断信息。 */
  diagnostics?: Record<string, unknown>;
}

export type SubagentNotification =
  | { type: 'message'; message: string; data?: unknown }
  | { type: 'completed'; message: string; data?: unknown }  // 任务正常完成
  | { type: 'user_stopped'; reason: string; data?: unknown }  // 用户主动停止（不是错误）
  | { type: 'failed'; error: string; data?: unknown; failure?: SubagentFailure }
  | { type: 'need_user_action'; message: string; data?: unknown };

/**
 * 通知投递回调的全仓唯一类型：返回 delivered——
 * false = 目标已拆除未送达。消费点不得以局部类型断言把返回值盖成 void；
 * terminalReason 只允许在 delivered === true 时产生。
 */
export type NotificationDelivery = (notification: SubagentNotification) => boolean;

/** Runtime-only choices for one new Agent generation; never persisted in AgentRunConfig. */
export interface AgentLaunchOptions {
  /** Optional model override for this runtime generation only. */
  initialModel?: string;
  /** Welcome composer 独占 MCP runtime 的一次性接管 token；不持久化。 */
  mcpPrewarmToken?: string;
  /** First-turn images are launch payload, not persisted task-definition fields. */
  images?: Array<{ data: string; media_type: string }>;
}

export type TaskDefinitionModeId = 'normal' | 'plan';
export type TaskDefinitionPurpose = 'general' | 'messaging';

export interface TaskDefinition {
  definitionId: string;
  name: string;
  description: string;
  category?: string;
  purpose: TaskDefinitionPurpose;
  promptTemplate: string;
  systemPrompt?: string;
  defaultModeId: TaskDefinitionModeId;
  defaultApprovalMode: ApprovalMode;
  workspace?: string;
  metadata?: StandardTaskBindings;
  advancedSettings?: TaskAdvancedSettings;
  mcpServers?: string[];
  createdAt: string;
}

export interface AgentRunConfig {
  name: string;
  description: string;
  category?: string;
  promptTemplate: string;
  systemPrompt?: string;
  workspace?: string;
  bindings?: AgentRunBindings;
  advancedSettings?: TaskAdvancedSettings;
  mcpServers?: string[];
}


/**
 * AI 请求瞬时状态——权威真相源由 engine 维护、经 ControlState 推送，
 * main/child 统一暴露。只服务 UI/日志/诊断，不参与控制流（Pump 正确性来自 return/abort）。
 * UI 禁止再从 AgentIncident 推断请求状态（禁止跨层推断）。
 */
export interface AIRequestState {
  /** 逻辑请求 ID（一个逻辑请求含其全部 attempts） */
  requestId: string;
  phase: 'requesting' | 'backoff' | 'compacting' | 'resending' | 'finished';
  /**
   * attempt 语义随 phase：
   * phase='requesting' 时为请求序号（0 起，0 = 首次请求）；
   * phase='backoff' 时为已失败的重试次数（1 起）。
   */
  attempt: number;
  /** 最大重试次数（不含首次请求；来自 provider 配置的显示近似） */
  maxAttempts: number;
  /** 整个逻辑请求（含全部 attempts）的开始时刻 */
  logicalStartedAt?: number;
  /** 当前 attempt 的开始时刻 */
  attemptStartedAt?: number;
  /** backoff 结束、下次 attempt 发起的时刻 */
  retryAt?: number;
  /** phase='finished' 时的结局 */
  outcome?: 'success' | 'failed' | 'cancelled';
  /** 最后一次错误类型码（如 rate_limit / empty_completed_response） */
  errorCode?: string;
  /** 最后一次错误消息（展示用） */
  errorMessage?: string;
}


// ============================================================
// 浏览器管理相关类型
// ============================================================

/**
 * 任务高级设置（绑定到 MainAgent 启动）
 */
/**
 * 运行时指纹配置（作为 BrowserLaunchSpec.fingerprint 传给内核浏览器）
 *
 * 这是从 BrowserIdentityPolicy 解析出的最终运行时形状，只保留内核浏览器仍需的
 * 设备身份与防泄漏策略。
 */
export interface RuntimeFingerprintConfig {
  /** 内核浏览器声明的 OS；留空时跟随真实宿主，避免跨 OS 字体矛盾。 */
  platform?: 'macos' | 'windows' | 'linux';
  /** 根据自定义 UA 同步设置 UA Client Hints。 */
  clientHintsFromUA?: boolean;
  /** WebRTC IP handling 策略：'proxy' 防泄露 / 'real' 默认。留空时配了代理即等同 'proxy'。 */
  webrtc?: 'proxy' | 'real';
  /** 自定义 CPU 逻辑核数；留空时使用目标平台预设。 */
  hardwareConcurrency?: number;
  /** 地理位置策略：'block' 让内核返回位置不可用；'real' 不拦截。 */
  geoMode?: 'block' | 'real';
  /** 浏览器内核理解的附加指纹选项。 */
  extra?: Record<string, unknown>;
}

export interface TaskAdvancedSettings {
  /** 浏览器语言（navigator.language / Accept-Language / Intl locale，如 'en-US'） */
  language?: string;
  /** 自定义 User-Agent */
  userAgent?: string;
  /** 后台模式：浏览器启动即隐藏，禁止后台节流 */
  backgroundMode?: boolean;
  /** 内核浏览器身份与防泄漏配置 */
  fingerprint?: RuntimeFingerprintConfig;
}

// ============================================================================
// 浏览器环境管理
// 本地全局资产，由本机统一管理。
// ============================================================================

/** 用户持久声明的浏览器身份策略；启动时解析为一次性 BrowserLaunchIdentity。 */
export interface BrowserIdentityPolicy {
  /** 内核浏览器声明的 OS；留空时跟随真实宿主。 */
  platform?: 'macos' | 'windows' | 'linux';
  userAgent?: string;
  timezone:
    | { mode: 'ip' }
    | { mode: 'real' }
    | { mode: 'custom'; value: string };
  geolocation:
    | { mode: 'ip' }
    | { mode: 'off' }
    | { mode: 'custom'; latitude: number; longitude: number; accuracy?: number };
  language:
    | { mode: 'ip' }
    | { mode: 'custom'; value: string };
  /** 逻辑核数；留空时使用目标平台预设。 */
  hardwareConcurrency?: number;
  extra?: Record<string, unknown>;
}

/** 浏览器扩展（预留结构） */
export interface BrowserExtension {
  id: string;
  name: string;
  /** 解压扩展目录 / .crx 解包后路径 */
  path: string;
  createdAt: number;
}

/** 环境分组 */
export interface BrowserEnvironmentGroup {
  id: string;
  name: string;
  createdAt: number;
}

/**
 * 浏览器环境
 * 本地全局资产，由本机统一管理。
 */
export interface BrowserEnvironment {
  id: string;
  name: string;
  /** 给 AI 看的用途说明（≤200 字）：这个浏览器是干什么的、什么时候该用它 */
  purpose?: string;
  groupId?: string;
  /** 可选的组织标签（用途/平台），仅供用户归类筛选；环境本身通用，不绑平台 */
  platform?: string;
  identityPolicy: BrowserIdentityPolicy;
  /** 关联代理 id */
  proxyId?: string;
  /** 绑定的扩展 id 列表 */
  extensionIds?: string[];
  status: 'idle' | 'running';
  /** 运行中的浏览器实例 id */
  currentBrowserId?: string;
  /** 当前 generation 与最新环境/代理配置不一致，需要重启后生效。 */
  restartRequired?: boolean;
  /** 绑定的 piskiepilot userDataId（启动时用于隔离） */
  userDataId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** 创建环境入参 */
export interface CreateBrowserEnvironmentRequest {
  name: string;
  purpose?: string;
  groupId?: string;
  platform?: string;
  identityPolicy?: BrowserIdentityPolicy;
  proxyId?: string;
  extensionIds?: string[];
}

/**
 * Agent 状态变更事件数据
 */
export interface AgentStateChangeEvent {
  agentId: string;
  state: _AgentControlState | null;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'auto';
  language: 'zh-CN' | 'en-US';
  navEdgeDockEnabled: boolean;
  navPrismEnabled: boolean;
  navPrismSpot: { x: number; y: number } | null;
  backgroundImage: string | null;
  backgroundMaskOpacity: number;
}

// ============================================================
// 外部事件注入相关类型
// ============================================================

/**
 * 事件来源类型
 * - user: 用户手动输入
 * - api: 外部 API 调用
 * - webhook: Webhook 回调
 * - system: 系统内部（如父流程消息）
 * - browser: 浏览器事件（预留）
 * - module: 模块扩展
 * - parent: 父流程发给子流程的消息（subagent 模块转发）
 */
export type AgentInputSource =
  | 'user'
  | 'api'
  | 'webhook'
  | 'system'
  | 'browser'
  | 'module'
  | 'parent'
  | 'subagent';

/**
 * 用户提交旁路：随同一次提交携带、明确不属于模型正文的结构化数据。
 * 判别联合限制允许形状——不叫 metadata（语义过宽）也不叫 presentation（暗示布局）。
 * 当前唯一成员：QuestionGate 的逐题原始答案数组。
 */
export type UiSubmission =
  | Readonly<{
      kind: 'ask_user_answer';
      answers: string[];
    }>;

/**
 * 外部注入事件
 * 用于从前端、API 或其他外部来源向 Agent 注入事件
 */
export interface AgentInputEvent {
  /** 事件 ID */
  id: string;
  /** 事件时间戳 */
  timestamp: Date;
  /** 事件来源 */
  source: AgentInputSource;
  /** 事件内容（用户消息或结构化数据） */
  content: string | Record<string, unknown>;
  /** 可选的优先级提示（AI 参考，不强制） */
  priority?: 'high' | 'normal' | 'low';
  /** 可选的元数据 */
  metadata?: Record<string, unknown>;
  /** 附带的图片（base64） */
  images?: Array<{
    data: string;        // 纯 base64 数据（不含 data: 前缀）
    media_type: string;  // 如 "image/png", "image/jpeg"
  }>;
  /** 用户提交旁路：不进模型正文，仅在 ask_user 配对边界消费 */
  uiSubmission?: UiSubmission;
}

/**
 * post() 入参类型：id/timestamp 可缺省（由归一化补全），其余字段必填。
 * 类型诚实化——不让类型说"完整"而正文说"待补全"。
 */
export type AgentInputRequest =
  Omit<AgentInputEvent, 'id' | 'timestamp'> & Partial<Pick<AgentInputEvent, 'id' | 'timestamp'>>;

/**
 * 事件队列快照（用于前端展示）
 * 不暴露完整事件内容，只提供统计信息
 */
export interface EventQueueSnapshot {
  /** 待处理事件数量 */
  pendingCount: number;
  /** 正在处理的事件数量 */
  processingCount: number;
  /** 最早的待处理事件时间戳（用于显示等待时长） */
  oldestPendingTime?: Date;
}

/**
 * 单帧截图数据。实时流直接走 MessagePort，不经过此结构。
 */
export interface ScreenFrame {
  /** 二进制 JPEG 图片数据（CDP screencast 输出） */
  data: Uint8Array;
  /** 帧时间戳 */
  timestamp: number;
  /** 生成该帧的浏览器 ID */
  browserId: string;
}

/**
 * 浏览器后台启动时用于把焦点留在应用窗口的平台标识。
 */
export interface CallerWindowConfig {
  /** Windows: 窗口句柄 (HWND) */
  hwnd?: number;
  /** macOS: 进程 ID */
  pid?: number;
  /** macOS: Bundle ID（推荐，打包后使用） */
  bundleId?: string;
  /** Linux: X11 窗口 ID（十六进制格式，如 "0x04600003"） */
  windowId?: string;
}

// ============================================================
// 计划与任务看板类型（plan 正文与执行期 Task Board 分离）
// ============================================================

/**
 * 任务项状态
 */
export type TaskItemStatus = 'pending' | 'in_progress' | 'completed';

/**
 * Task Board 中可独立追踪和修改的细任务。
 */
export interface TaskItem {
  /** 看板内稳定且唯一的逻辑任务 ID */
  id: string;
  /** 短而具体的可交付成果名称 */
  subject: string;
  /** 单项任务的持久化执行范围、产出与验收事实 */
  description: string;
  /** 工作义务的当前进度 */
  status: TaskItemStatus;
  /** 当前责任 Agent ID；null 表示尚未分配 */
  owner: string | null;
  /** 前置任务的稳定 ID；无依赖时是空数组 */
  dependsOn: string[];
}

/**
 * 当前 Main 实例唯一持久化的 Task Board。
 */
export interface TaskBoardData {
  schemaVersion: 1;
  /** 当前顶层任务标题 */
  taskSummary: string;
  /** 全部细任务的扁平唯一集合 */
  items: TaskItem[];
}

/** Worker 创建时写入初始对话的一次性紧凑看板快照。 */
export interface AssignmentTaskBoardSnapshot {
  taskSummary: string;
  items: Array<{
    id: string;
    subject: string;
    status: TaskItemStatus;
    owner: string | null;
    dependsOn: string[];
    assignedHere: boolean;
  }>;
}

/**
 * 计划元信息（计划正文落盘 plans/<planId>.md，指针存 plans/current.json）
 */
export interface PlanMeta {
  /** 计划 ID（= 正文文件名去扩展） */
  planId: string;
  /** 任务摘要 */
  taskSummary: string;
  /** 正文文件绝对路径 */
  documentPath: string;
  /** 创建时间 */
  createdAt: string;
}

// ============================================================
// 上下文压缩类型
// ============================================================

export * from './context.js';

// ============================================================
// Agent incident 与系统日志类型
// ============================================================

export * from './agent-incidents.js';
export * from './system-logs.js';

// ============================================================
// 代理配置类型
// ============================================================

export * from './proxy.js';

// ============================================================
// Image Node 类型（生图节点）
// ============================================================

/**
 * 单张图片状态（candidatePath 指向 OS 临时目录候选文件，
 * outputPath 是 AI 指定的最终绝对路径；不携带 base64）
 */
export interface ImageItem {
  /** 图片唯一 ID */
  id: string;
  /** 图片描述（prompt） */
  prompt: string;
  /** 图片尺寸 */
  size?: string;
  /** AI 指定的最终绝对路径（调用契约） */
  outputPath: string;
  /** 目标已存在时是否允许覆盖（默认 false） */
  overwrite?: boolean;
  /** 图片状态 */
  status: 'generating' | 'completed' | 'error';
  /** 候选文件路径（OS 临时目录）；预览读取源按节点状态选择 */
  candidatePath?: string;
  /** 候选文件真实 MIME */
  mimeType?: string;
  /** 候选版本（每次重生成成功 +1，前端据此刷新预览） */
  version: number;
  /** 供应商返回的优化后 prompt */
  revisedPrompt?: string;
  /** 审核期用户最后一次成功应用的修改指令（写入最终 tool result 告知 AI，防止 AI 把用户改动当问题返工） */
  userInstruction?: string;
  /** 错误信息（重生成失败时保留旧候选、只记录错误） */
  error?: string;
}

/**
 * 图片节点状态（Canvas 节点的状态机）
 */
export interface ImageNodeState {
  /** 节点唯一 ID */
  id: string;
  /** 创建该节点的 Agent ID */
  agentId: string;
  /** 节点状态：approved/partial/failed/cancelled 是结算出口，没有出口回到 pending */
  status: 'generating' | 'preview' | 'pending_approval' | 'regenerating' | 'committing'
    | 'approved' | 'partial' | 'failed' | 'cancelled';
  /** 图片列表 */
  images: ImageItem[];
  /** 创建时间 */
  createdAt: Date;
  /** 本审核节点固定使用的精确 Provider/model；创建后不随全局配置漂移 */
  target: {
    providerId: string;
    modelId: string;
  };
  /** preview 模式下倒计时截止时间戳 */
  previewDeadline?: number;
  /** 用户删除的图片数（计入最终 tool result 的 deletedCount） */
  deletedCount?: number;
}

/** 图片单项公开投影（轻量路径状态，不携带 base64） */
export interface ImageItemPublicState {
  id: string;
  prompt: string;
  outputPath: string;
  candidatePath?: string;
  mimeType?: string;
  version: number;
  status: 'generating' | 'completed' | 'error';
  error?: string;
}

/** 图片节点公开投影（getControlState 每次从 ImageModule 即时派生，不维护第二份 Map） */
export interface ImageNodePublicState {
  id: string;
  status: ImageNodeState['status'];
  target: {
    providerId: string;
    modelId: string;
  };
  previewDeadline?: number;
  createdAt: number;
  images: ImageItemPublicState[];
}
