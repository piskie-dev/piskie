/**
 * 提示词上下文类型
 * 供 assemble() 与各层片段函数使用（L0-L5 组装架构）
 */

import type { ApprovalMode } from '../../../shared/types/index.js';

export interface PromptContext {
  // === Role context ===
  /** 当前 Agent 的真实运行时 ID；Task Board owner 使用此值 */
  agentId: string;
  /** Agent 角色（director/worker） */
  role: 'director' | 'worker';
  /** 所属顶层 Agent ID（仅 worker 需要展示） */
  /** 当前运行的显示名称 */
  runName: string;

  // === Derived tool surface ===
  /** 最终可见工具面是否包含 agent_run 工具。 */
  canManageAgentRuns: boolean;

  // === 用户自定义指令（<user_instructions> 槽位，L2 之后 L3 之前） ===
  /** 用户级指令（AgentRunConfig.systemPrompt / 自定义 Agent 类型的 systemPromptPrefix） */
  userInstructions?: string;

  // === L3 模式（仅顶层 agent 设置；worker 恒无） ===
  /** 当前执行模式。 */
  modeId?: string;
  /** 审批模式（confirm/auto） */
  approvalMode?: ApprovalMode;

  // === L4 技能文档 ===
  /** 核心技能文档（从 piskiepilot 运行时加载） */
  skillDocs: string;

  // === L5 动态上下文 ===
  /** 用户工作空间路径（产出物存放位置） */
  workspaceDir: string;
  /** 临时文件路径 */
  tempDir: string;
  /** <available_skills> 块内文本（注入时刻快照渲染，含降级/别名/触发规则；仅顶层） */
  availableSkillsBlock?: string;
  /** <mcp_tools> 块内文本（deferred 名字行清单 + 直注 server 使用说明；main/worker 各自快照） */
  mcpBlock?: string;

  // === Worker-specific（仅 role === 'worker' 时使用） ===
  /** 加载的技能列表 */
  skills?: string[];
  /** Director 模式：绑定的浏览器环境池（精确 ID + 名称 + 用途说明） */
  boundEnvironments?: Array<{ id: string; name: string; purpose: string }>;
}
