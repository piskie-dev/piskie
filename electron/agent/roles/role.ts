/**
 * AgentRole — 角色行为策略接口
 * 每个 agent 有且仅有一个 Role，由 Spec 的 role 字段决定。
 */

import type {
  AgentRunConfig,
  ApprovalMode,
  AgentModeId,
  SubagentConfig,
} from '../../../shared/types/index.js';
import type { ReasoningSelection } from '../../../shared/types/reasoning.js';
import type { ResolvedBrowserBinding } from '../modules/browser-binding.js';
import type { PromptContext } from '../prompts/types.js';
import type { ToolContextBuilder } from '../tool-context.js';
import type { AgentHost } from '../agent-host.js';
import type { AgentRuntimeObserverFactory } from '../observations.js';
import type { McpCapabilitySnapshot } from '../../mcp/runtime/capability.js';

// ============================================================
// 角色类型
// ============================================================

export type RoleType = 'director' | 'worker';

// ============================================================
// AgentRole 接口
// ============================================================

export interface AgentRole {
  /** 构造阶段：返回角色默认值（替代构造函数 8 个 if 分支） */
  getDefaults(options: RuntimeOptions): RoleDefaults;

  /** 生命周期：首次启动（替代 start 分支） */
  onStart(host: AgentHost, options: RuntimeOptions): Promise<void>;

  /** 生命周期：中断后处理（写 header.json 等） */
  onAfterInterrupt(host: AgentHost): void;

  /** 冲程 turn 配置（runPump 每冲程 lazy 求值） */
  configureLoop(host: AgentHost): LoopConfig;

  /** 上下文扩展：提示词 */
  enrichPromptContext(ctx: PromptContext, host: AgentHost, options: RuntimeOptions): void;

  /** 上下文扩展：工具 */
  enrichToolContext(builder: ToolContextBuilder, host: AgentHost, options: RuntimeOptions): void;

  /** Module 运行时配置（替代 buildRuntimePluginConfig 分支） */
  buildModuleConfig(host: AgentHost, options: RuntimeOptions): Record<string, Record<string, unknown>>;
}

// ============================================================
// 循环配置
// ============================================================

export interface LoopConfig {
  /** 函数形式在每个工具批次开始前求值；批次开始后本次调度保持不变。 */
  executeMode: 'sequential' | 'parallel' | (() => 'sequential' | 'parallel');
  onBeforeExecuteTools?: (toolUses: ToolUseInput[]) => void;
  onAfterExecute?: (toolUse: ToolUseInput, result: unknown) => void;
}

export interface ToolUseInput {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ============================================================
// 角色默认值
// ============================================================

export interface RoleDefaults {
  approvalMode: ApprovalMode;
  mainAgentId: string | null;
}

// ============================================================
// Runtime 构造选项
// ============================================================

export interface RuntimeOptions {
  mainAgentId: string;
  runConfig?: AgentRunConfig;
  subagentConfig?: SubagentConfig;
  browserBinding?: ResolvedBrowserBinding;
  initialApprovalMode?: ApprovalMode;
  initialModeId?: AgentModeId;
  initialModel?: string;
  initialReasoning?: ReasoningSelection;
  images?: Array<{ data: string; media_type: string }>;
  /** Composer prewarm 的一次性 owner token；只允许 Main 接管。 */
  mcpPrewarmToken?: string;
  /** Worker 只能收窄此 Main 能力快照，不得重新扫描磁盘扩张能力。 */
  parentMcpCapability?: McpCapabilitySnapshot;
  workspace?: string;
  /** Resume 场景：跳过初始任务注入（上下文已由 replay 重建），环境准备照常执行 */
  isResume?: boolean;
  /**
   * 升级直达通道回调：子代理自主回收 destroy 失败时经此直达 Service。
   * 回调绑定具体 runtime 实例（Service 侧验证 activeRuntimes.get(id) === runtime 防旧世代误停）；
   * 不经 Mailbox；零新状态。未注入时 runtime 降级为 error 日志。
   */
  onFatalTeardown?: (error: unknown) => void;
  /** 为当前 Runtime 或其子 Runtime 创建仅写观察器，不暴露订阅能力。 */
  createRuntimeObserver?: AgentRuntimeObserverFactory;
  allocateAgentId?: () => string;
  [key: string]: unknown;
}
