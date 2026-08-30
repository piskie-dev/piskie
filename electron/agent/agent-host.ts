/**
 * AgentHost — Module/Role 与 Runtime 交互的窄接口
 * 替代所有 (this.agent as any) 访问。
 * 只暴露 Module/Role 真正需要的方法。
 */

import type { ApprovalMode, MessageSubtype } from '../../shared/types/index.js';
import type {
  AgentControlState,
  AgentRunHeader,
  AgentPhase,
  ConversationWriteEntry,
} from '../../shared/types/agent-control.js';
import type { AgentSpec } from './specs/spec.js';
import type { AgentModule } from './modules/module.js';
import type { AgentMailbox } from './agent-mailbox.js';
import type { AgentInferencePort } from '../inference/application/agent-inference-port.js';
import type { ModelTarget } from '../inference/execution/contracts.js';
import type {
  BrowserControlPort,
  SkillCatalogPort,
} from '../core/pilot/pilot-manager.js';
import type { ConversationStore } from '../agent-runs/conversation-store.js';
import type { ReasoningSelection } from '../../shared/types/reasoning.js';
import type { McpCapabilitySnapshot } from '../mcp/runtime/capability.js';

export interface AgentUserInput {
  readonly text: string;
  readonly subtype?: MessageSubtype;
  readonly images?: readonly { data: string; media_type: string }[];
}

export interface AgentHost {
  // --- 只读属性 ---
  readonly id: string;
  readonly mainAgentId: string;
  readonly currentModel: string;
  readonly currentTarget: ModelTarget;
  readonly reasoningOverride: ReasoningSelection;
  readonly approvalMode: ApprovalMode;
  readonly phase: AgentPhase;
  readonly interrupted: boolean;
  readonly spec: AgentSpec;

  // --- 推送 ---
  emitStateChange(): void;
  getControlState(): AgentControlState;

  // --- 上下文操作 ---
  addUserMessage(input: AgentUserInput): void;

  // --- 存储操作 ---
  getConversationStore(): ConversationStore;
  appendConversationEntry(entry: ConversationWriteEntry): void;
  buildHeader(): AgentRunHeader;

  // --- 基础设施 ---
  getInference(): AgentInferencePort;
  getSkillCatalog(): SkillCatalogPort | null;
  getBrowserControl(): BrowserControlPort | null;
  getMailbox(): AgentMailbox;
  /** Worker 创建只读取能力上界，不暴露 Main 的 live MCP handle。 */
  getMcpCapabilitySnapshot(): McpCapabilitySnapshot | undefined;

  // --- 模块查询 ---
  getModule<T extends AgentModule>(name: string): T | undefined;

  // --- 事件注入（post 是事件唯一写入点，返回是否被接收——false = runtime 已拆除） ---
  post(input: import('../../shared/types/index.js').AgentInputRequest): boolean;

  /**
   * 升级直达通道：致命 teardown 失败直达 Service（stopAgent(本 runtime)）。
   * 控制通道不是业务事件——不经 Mailbox、不等 AI/Pump（升级场景恰是"本 runtime 可能出事了"，
   * post 会被投递门拒收、Pump 可能挂死）。同步发起即返回；消费与世代验证在 Service 侧。
   */
  reportFatalTeardown(error: unknown): void;

  // --- 工具链 ---
  getSkillDocs(): string;
  setSkillDocs(docs: string): void;
}
