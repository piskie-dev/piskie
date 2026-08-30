/**
 * 工具系统类型定义
 */

import type {
  ApprovalMode,
  AgentRunConfig,
  AssignmentTaskBoardSnapshot,
  AgentInputRequest,
  AgentModeId,
  SubagentNotification,
  SubagentConfig,
  SubagentMode,
  TaskItem,
  ToolArtifact,
  ToolInputSchema,
} from '../../shared/types/index.js';
import type { SkillInventorySnapshot } from '../../shared/types/skill.js';
import type { ImageReviewOps } from './image/image-review-types.js';
import type { ParamSpec } from './params.js';
import type { BrowserHostRuntime } from '../piskiepilot/core/skill/host.js';

/**
 * 工具作用域
 * - main: 仅 MainAgent 可用
 * - subagent: 仅 Subagent 可用
 * - shared: 两者都可用
 */
export type ToolScope = 'main' | 'subagent' | 'shared';
export type ToolAgentType = 'main' | 'worker';

// ============================================================================
// Unified tool protocol
// ============================================================================

export type ImageRef = Readonly<{
  base64: string;
  mediaType: string;
}>;

export type ToolOutput<TData = undefined> =
  | { ok: true; text: string; images?: ImageRef[]; data?: TData; artifacts?: ToolArtifact[] }
  | { ok: false; text: string; images?: ImageRef[]; data?: TData; artifacts?: ToolArtifact[] };

export type PersistedOutput = Readonly<{
  path: string;
  bytes: number;
  preview: string;
  incomplete?: Readonly<{
    observedBytes: number;
    reason: string;
  }>;
}>;

export type ToolResult = {
  ok: boolean;
  text: string;
  images?: ImageRef[];
  persisted?: PersistedOutput;
};

/** The only ToolOutput -> ToolResult conversion. Diagnostic data and artifacts stop here. */
export function toToolResult<TData>(output: ToolOutput<TData>): ToolResult {
  return {
    ok: output.ok,
    text: output.text,
    ...(output.images?.length ? { images: output.images } : {}),
  };
}

export type WorkspaceContext = Readonly<{ dir: string; tempDir: string }>;

export type VersionToken = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}>;

export type GuardVerdict = 'absent' | 'unread' | 'stale' | 'current';

export interface FileGuardPort {
  check(canonicalPath: string): Promise<GuardVerdict>;
  record(canonicalPath: string, token: VersionToken, kind: 'read' | 'write'): void;
  forget(canonicalPath: string): void;
}

export interface OutputSpoolPort {
  write(chunk: Buffer, stream: 'out' | 'err'): void;
  textForModel(): string;
  spilled(): PersistedOutput | null;
  dispose(): void;
}

export interface BackgroundJob {
  readonly outFile: string;
  kill(): Promise<void>;
  exited(): Promise<{
    status: 'ok' | 'failed' | 'killed';
    exitCode?: number;
    durationMs: number;
    tail: string;
  }>;
}

export interface BackgroundHandle {
  readonly id: string;
  readonly outFile: string;
}

export interface BackgroundHost {
  offer(job: BackgroundJob): { promoted: Promise<'user'>; withdraw(): void };
  adopt(job: BackgroundJob, reason: 'declared' | 'timeout' | 'user'): BackgroundHandle;
}

export interface BackgroundHostFactory {
  forCall(callId: string, post: (event: AgentInputRequest) => boolean): BackgroundHost;
}

export interface ModesPort {
  modeId(): AgentModeId;
  approvalMode(): ApprovalMode;
}

export interface TaskBoardPort {
  set(value: { taskSummary: string; items: TaskItem[] } | null): void;
}

export interface PlanPort {
  setCurrentPlanId(id: string): void;
  exitPlan(): void;
}

export type SubagentTypeDescriptor = Readonly<{
  name: string;
  description: string;
  mode: SubagentMode;
}>;

export interface SubagentPort {
  resolveType(type: string):
    | { mode: SubagentMode; agentSpec?: string }
    | { error: string };
  create(config: SubagentConfig, snapshot: AssignmentTaskBoardSnapshot): Promise<string>;
  destroy(id: string): Promise<void>;
  traceFilePath(id: string): string | undefined;
}

export interface EventPort {
  allowedTargets(): readonly string[];
  send(targetId: string, event: Record<string, unknown>): boolean;
  notifyParent(event: SubagentNotification): boolean;
}

export type ImageOpsPort = ImageReviewOps;

/**
 * deferred MCP 工具的清单与装载（tool_search 专用）。
 * 装载集只增不减；装载后 schema 随下一次模型请求进入工具表。
 */
export interface DeferredToolsPort {
  list(): readonly { modelName: string; server: string; description: string }[];
  load(names: readonly string[]): { loaded: string[]; unknown: string[] };
}

export type ToolResourceIds = Readonly<{
  browserId?: string;
}>;

export interface ToolContext {
  readonly agentId: string;
  readonly callId: string;
  readonly workspace: WorkspaceContext;
  readonly signal: AbortSignal;
  readonly spool?: OutputSpoolPort;
  readonly files?: FileGuardPort;
  declareTerminal(reason: TerminalReason): void;
  post(event: AgentInputRequest): boolean;
  readonly background?: BackgroundHost;
  readonly agentType: ToolAgentType;
  readonly agentSpec: string;
  readonly mainAgentId: string;
  readonly runConfig: Readonly<AgentRunConfig>;
  readonly subagentConfig?: Readonly<SubagentConfig>;
  readonly resourceIds: ToolResourceIds;
  readonly assignmentSnapshot?: Readonly<AssignmentTaskBoardSnapshot>;
  /** 注入时刻的 <available_skills> manifest 快照（tool_search 互斥基准；仅授予 tool_search） */
  readonly skillInventory?: Readonly<SkillInventorySnapshot>;
  /** deferred MCP 工具的清单与装载（仅授予 tool_search） */
  readonly deferredTools?: DeferredToolsPort;
  readonly currentModel: string;

  readonly modes: ModesPort;
  readonly taskBoard?: TaskBoardPort;
  readonly plan?: PlanPort;
  readonly subagents?: SubagentPort;
  readonly events?: EventPort;
  readonly imageOps?: ImageOpsPort;
  readonly browser?: BrowserHostRuntime;
}

export type ToolEffect = 'read-fs' | 'write-fs' | 'exec' | 'agent-control' | 'external';

/** 终态原因：仅在终态事件成功送达后声明。 */
export type TerminalReason = 'completed' | 'failed' | 'user_stopped';

type StringKeys<T> = {
  [K in keyof T]-?: T[K] extends string | undefined ? K & string : never;
}[keyof T];

export type ToolPolicy<TParams> = {
  pathParams?: { [K in StringKeys<TParams>]?: 'absolute' | 'workspace-default' };
  mutation?: {
    pathParam: StringKeys<TParams>;
    priorRead: 'required' | 'if-exists' | 'none';
  };
  records?: { pathParam: StringKeys<TParams> };
  exclusive?: boolean;
  backgroundable?: boolean;
  streamingOutput?: boolean;
};

export type ToolDef<TParams> = {
  name: string;
  description: string | ((agentType: ToolAgentType) => string);
  schema: ParamSpec<TParams>;
  /** Optional model-only refinement; runtime validation always uses schema above. */
  modelInputSchema?: (
    schema: ToolInputSchema,
    context: Readonly<{
      agentType: ToolAgentType;
      subagentTypes: readonly SubagentTypeDescriptor[];
      subagentResources: Readonly<{
        browserEnvironmentIds: readonly string[];
      }>;
    }>,
  ) => ToolInputSchema;
  scope: ToolScope;
  effects: ToolEffect[];
  policy?: ToolPolicy<TParams>;
};

export type PreviewThunk = () => Promise<PreviewInfo>;

export interface ITool<TParams = unknown, TData = undefined> {
  readonly def: ToolDef<TParams>;
  execute(
    params: TParams,
    context: ToolContext,
  ): Promise<ToolOutput<TData> | ToolSuspension>;
  prepare?(params: TParams, context: ToolContext): Promise<PreviewThunk>;
}

export type RawCall = { modelName: string; rawParams: unknown; callId: string };

export type PreparedCall<TParams> = {
  readonly entry: import('./catalog.js').CatalogEntry;
  readonly params: TParams;
  readonly ctx: ToolContext;
  readonly callId: string;
  preview?: PreviewThunk;
};

export type Rejection = { text: string };

/**
 * 预览信息（用于 dryRun 机制）
 * 与 shared/types 中的 PreviewInfo 保持一致
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
 * 工具定义（供 AI 使用）
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

/** 主进程内过程通知；Canvas 终态只从持久化 conversation 投影。 */
interface AgentContentEventBase {
  content?: string;
  toolCallId?: string;
  toolName?: string;
  params?: Record<string, unknown>;
  result?: string;
}

export type AgentContentEvent =
  | (AgentContentEventBase & { type: 'assistant_text' })
  | (AgentContentEventBase & { type: 'tool_start' })
  | (AgentContentEventBase & { type: 'tool_finish'; ok: boolean })
  | (AgentContentEventBase & { type: 'turn_end' });

/** 挂起提问（ask_user 面板同构渲染） */
export interface SuspensionQuestion {
  question: string;
  options?: string[];
  multiSelect?: boolean;
}

/**
 * 带续跑的挂起：工具在途请求要求补充用户输入（MCP elicitation / MRTR）。
 * 与 ask_user 不同，问题来自服务器的瞬时响应而非 tool_use 参数——
 * 进程内有效，重启后在途请求作废（恢复守卫按缺失结果写 interrupted）。
 */
export interface ToolSuspensionContinuation {
  questions: SuspensionQuestion[];
  /**
   * 用户作答后续跑原调用。answers 与 questions 一一对应；
   * 返回最终输出，或下一轮挂起（服务器多轮追问）。
   */
  resume(answers: string[]): Promise<ToolOutput<unknown> | ToolSuspension>;
  /** 拒答/中断：对服务器回 cancel，在途调用随之退场 */
  cancel(): void;
}

/**
 * 工具挂起信号：冲程内控制信号，非持久真相。
 * ask_user 校验成功后返回（无 continuation——答案即结果）；
 * MCP 工具在途 elicitation 时返回（带 continuation——答案喂回原请求续跑）。
 * 当前冲程不写 tool_result、不发完成事件，Pump yield 等待。
 */
export interface ToolSuspension {
  suspended: true;
  reason: 'user_input';
  continuation?: ToolSuspensionContinuation;
}

export function isToolSuspension(outcome: unknown): outcome is ToolSuspension {
  return typeof outcome === 'object'
    && outcome !== null
    && 'suspended' in outcome
    && outcome.suspended === true;
}
