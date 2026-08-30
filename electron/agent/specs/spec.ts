/**
 * AgentSpec — 声明式 Agent 类型规格定义
 * 每个 Spec 只描述真正驱动 Runtime 的角色、工具、模块和提示词。
 */

import type { RoleType } from '../roles/role.js';
import type { PromptContext } from '../prompts/types.js';

/** 工具集配置 */
export interface ToolSetConfig {
  /** Directly exposed fixed Skill groups, such as browser. */
  sdkGroups: string[];
  /** Native model-facing tool names, such as read, subagent, and send_event. */
  customTools: string[];
  /**
   * 工具名黑名单（精确匹配，可选）
   * 用于精准禁掉 prompt 已禁止但 AI 偶尔仍误调的工具（如 tool_search）
   * 或 director 永远不该用的危险工具（如 shell）
   * 只挡少量特定项，不改变其他默认行为。
   */
  exclude?: string[];
}

/**
 * 子代理生命周期策略（策略下沉 Spec）
 *
 * 生命周期是 agent 类型的策略，不是 AI 每次调用的决策——由本声明驱动，
 * 执行机制在 subagent.module.ts（终态处置 + watchdog 巡检）。
 */
export interface SubagentLifecycle {
  /**
   * 终态事件（completed/failed/user_stopped）后的处置：
   * - 'grace'（默认）：保留宽限期供父续任务/追问（复用已登录热浏览器），到期系统自动回收
   * - 'immediate'：立即回收
   */
  onTerminal?: 'grace' | 'immediate';
  /** 宽限期时长（毫秒），仅 onTerminal='grace' 生效；缺省用 DEFAULT_SUBAGENT_GRACE_MS */
  graceMs?: number;
  /** 硬超时（毫秒）：首次到期先请求任务状态确认；确认后再次到期则注入 failed 并强制回收 */
  deadlineMs?: number;
  /**
   * stalled 上报门限（毫秒）：首次到期先请求任务状态确认；确认后再次到期只向父流程
   * 上报 stalled 事件、不销毁（与 deadlineMs 是两个独立策略，不共用字段）。边沿触发，
   * 每次 stall 仅上报一次，活动恢复即复位。缺省 STALLED_CONFIG.defaultStalledAfterMs（10 分钟）。
   */
  stalledAfterMs?: number;
}

export interface AgentSpec {
  /** 唯一标识 */
  name: string;
  /** Director 创建专属 Worker 时展示给模型的简短职责；通用 browser/local 不使用。 */
  subagentTypeDescription?: string;
  /** 角色：决定 Agent 的行为策略（director/worker） */
  role: RoleType;
  /** 工具集配置 */
  tools: ToolSetConfig;
  /** 模块列表（按名称引用，从 modules/index.ts 工厂创建） */
  modules: string[];
  /** 模块专属配置（key = 模块名） */
  moduleConfig?: Record<string, Record<string, unknown>>;
  /** 构建系统提示词 */
  buildSystemPrompt: (ctx: PromptContext) => string;
  /** 作为子代理运行时的生命周期策略（缺省 = 终态后宽限期回收，无硬超时） */
  lifecycle?: SubagentLifecycle;
  /** 同一 Director 会话内串行复用浏览器和 Profile。 */
  shareDirectorBrowser?: boolean;
  /**
   * 可创建此 Worker 的父 AgentSpec 白名单。省略表示沿用通用行为；只有领域专属
   * Worker 需要声明，不能用 Assignment 自由文本授予该权限。
   */
  allowedParentSpecs?: readonly string[];
  /** MCP server 有序 allowlist；仅可在 AgentRun allowlist 内继续收窄，不能扩大。 */
  mcpServers?: readonly string[];
}
