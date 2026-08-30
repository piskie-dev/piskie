import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * AgentRuntime — 统一 Agent 运行时
 *
 * 替代 UnifiedAgent。零 if 分支，通过 Role + Module + Spec 组合行为。
 *
 * 核心设计：
 * - 构造函数零条件分支 — 所有角色差异由 Role.getDefaults() 提供
 * - Role 决定执行策略（循环配置、提示词扩展、工具上下文扩展）
 * - Module 提供可组合能力（子流程管理、浏览器控制、图片处理等）
 * - Spec 声明式描述 Agent 类型（工具集、模块列表、能力声明）
 * - 实现 AgentHost 接口，供 Module/Role 类型安全地访问运行时
 * - 没有 resume() 方法 — Resume 是 Service 层操作（创建新 runtime + replay + start）
 */

import type { AgentInferencePort } from '../inference/application/agent-inference-port.js';
import {
  formatModelTarget,
  parseModelTargetReference,
} from '../inference/execution/model-target.js';
import { RecordedAIRequestError } from '../core/ai/ai-request-error.js';
import type { AgentPilotPorts, BrowserControlPort, SkillCatalogPort } from '../core/pilot/index.js';
import type { ConversationStore } from '../agent-runs/conversation-store.js';
import type { AgentContentEvent } from '../tools/types.js';
import type { AgentLiveContentDelta } from '../../shared/electron-contracts/agents.js';
import type { AgentRuntimeObserver } from './observations.js';
import type {
  AgentTarget,
  AgentControlState,
  ConversationAppendMetadata,
  ConversationEntry,
  ConversationWriteEntry,
  ChildControlState,
  AgentRunHeader,
  ChildSnapshot,
  PendingAgentEventView,
} from '../../shared/types/agent-control.js';
import type {
  AgentInputEvent,
  AgentInputRequest,
  AgentRunConfig,
  ApprovalMode,
  AgentModeId,
  ToolApprovalDecision,
  SubagentNotification,
  NotificationDelivery,
  MessageSubtype,
  ContentBlock,
  SubagentMode,
  SubagentConfig,
  AIQuestion,
  ToolArtifact,
} from '../../shared/types/index.js';
import type { ReasoningSelection } from '../../shared/types/reasoning.js';

import type { AgentHost, AgentUserInput } from './agent-host.js';
import type { AgentSpec } from './specs/spec.js';
import { specRegistry } from './specs/index.js';
import type { AgentModule } from './modules/module.js';
import type { ImageModule } from './modules/image.module.js';
import type { AgentRole, RuntimeOptions } from './roles/role.js';
import type { PromptContext } from './prompts/types.js';
import { neutralizeClosing } from './prompts/context.js';
import { ToolContextBuilder } from './tool-context.js';
import type { ToolActivationContext } from './tool-call/context-builder.js';
import type { AgentMcpSession } from './mcp-session.js';
import type { McpCapabilitySnapshot } from '../mcp/runtime/capability.js';
import { sanitizeMcpErrorText } from '../mcp/security/sanitize.js';

import { AgentEngine, type TurnConfig } from './agent-engine.js';
import {
  getValidPendingAskUser,
  resolveToolUseSettlement,
} from './context/conversation-protocol.js';
import { ContextSettlementConversation, Settler } from './conversation/settler.js';
import { AgentMailbox, EventBatchApplyError } from './agent-mailbox.js';
import { agentIncidentStore } from '../observability/incidents/agent-incident-store.js';
import { AgentConversationContext } from './context/index.js';
import type { CatalogSnapshot, FinalToolFace } from '../tools/catalog.js';
import { occupancyRegistry } from '../core/occupancy/index.js';
import { createRole } from './roles/index.js';
import { createModule } from './modules/index.js';
import { pathsService } from '../services/paths.service.js';
import {
  browserSkillCandidateOverlay,
  canAccessBrowserSkillCandidate,
  type BrowserSkillCandidatePin,
} from '../browser-skill/candidate-overlay.js';

// ─── 构造选项 ────────────────────────────────────────────

export interface AgentRuntimeConfig {
  id: string;
  spec: AgentSpec;
  inference: AgentInferencePort;
  pilotPorts?: AgentPilotPorts;
  conversationStore: ConversationStore;
  onStateChange?: (state: AgentControlState) => void;
  observer?: AgentRuntimeObserver;
  options: RuntimeOptions;
}

function projectPendingEvent(event: AgentInputEvent): PendingAgentEventView {
  return {
    id: event.id,
    timestamp: event.timestamp.getTime(),
    source: event.source,
    content: typeof event.content === 'string' ? event.content : structuredClone(event.content),
    priority: event.priority,
    imageCount: event.images?.length ?? 0,
  };
}

// ─── AgentRuntime ────────────────────────────────────────

export class AgentRuntime extends AgentEngine implements AgentHost {
  private readonly role: AgentRole;
  private readonly modules: AgentModule[] = [];
  private readonly _spec: AgentSpec;
  private readonly options: RuntimeOptions;

  private readonly runtimeObserver?: AgentRuntimeObserver;
  private createdAt: Date;
  private prepared = false;
  private mcpSession?: AgentMcpSession;
  private unsubscribeMcp?: () => void;
  private browserSkillCandidatePin?: BrowserSkillCandidatePin;
  private modelBoundaryProjectionRevision = 0;
  private modelBoundaryProjectionKey?: string;

  constructor(config: AgentRuntimeConfig) {
    super();

    this._spec = config.spec;
    this.options = config.options;
    this.role = createRole(this._spec.role);
    this.createdAt = new Date();

    // Role 提供角色默认值（零条件分支）
    const defaults = this.role.getDefaults(this.options);

    // === 核心字段初始化 ===
    this.id = config.id;
    this.mainAgentId = this.options.mainAgentId;
    this.inference = config.inference;
    this.pilotPorts = config.pilotPorts;
    this.conversationStore = config.conversationStore;
    this.runtimeObserver = config.observer;
    this.stateChangeCallback =
      config.onStateChange || config.observer
        ? (state) => {
            config.onStateChange?.(state);
            config.observer?.stateChanged(state);
          }
        : undefined;

    // 模型
    const model = this.options.initialModel;
    if (!model) throw new Error('未配置 AI 模型，请在设置页面配置 Provider 和默认模型');
    this.currentTarget = parseModelTargetReference(model);
    this.inference.assertTarget(this.currentTarget);
    this.currentModel = formatModelTarget(this.currentTarget);
    const initialReasoning =
      (this.options.initialReasoning as ReasoningSelection | undefined) ??
      this.inference.resolveReasoning(this.currentTarget).selection;
    this.reasoningOverride = initialReasoning;
    this.reasoningByModel.set(this.currentModel, initialReasoning);

    // 审批模式（由 Role 提供默认值）
    this.approvalMode = defaults.approvalMode;

    // === 上下文管理器 ===
    const mainAgentId = defaults.mainAgentId || this.id;
    this.context = new AgentConversationContext({
      inference: this.inference,
      target: this.currentTarget,
      mainAgentId,
    });
    // write-before-emit：所有上下文写入先落盘到 conversation.jsonl
    this.context.setPersistHook((entry, metadata) => {
      this.appendConversationEntry(entry, metadata);
    });
    // 切模型后的异步重算落地时冲程可能已结束，没有这次广播界面会停在「—」
    this.context.setMeasurementHook(() => this.emitStateChange());
    // Recovery and interrupt settlement can run before prepare() builds the tool pipeline.
    this.settler = new Settler(
      new ContextSettlementConversation(this.context, (entry) =>
        this.appendConversationEntry(entry)
      ),
      (callId) => this.recordToolSettled(callId)
    );

    // === Incident target ===
    this.incidentTarget = this.buildRuntimeIncidentTarget();

    // === 模块初始化 ===
    const moduleConfig = this.role.buildModuleConfig(this, this.options);
    for (const moduleName of this._spec.modules) {
      const mod = createModule(moduleName);
      const mergedConfig = {
        ...this._spec.moduleConfig?.[moduleName],
        ...moduleConfig[moduleName],
      };
      mod.init(this, Object.keys(mergedConfig).length > 0 ? mergedConfig : {});
      this.modules.push(mod);
    }
  }

  // ============================================================
  // AgentHost 接口实现
  // ============================================================

  get spec(): AgentSpec {
    return this._spec;
  }

  // emitStateChange 不覆写：基类实现带 disposed 守卫（世代唯一性）。

  addUserMessage(input: AgentUserInput): void {
    if (!input.images?.length) {
      this.context.addUserMessage(input.text, input.subtype);
      return;
    }

    const content: ContentBlock[] = input.images.map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.media_type, data: image.data },
    }));
    if (input.text) content.push({ type: 'text', text: input.text });
    this.context.addUserMessage(content, input.subtype);
  }

  addDurableUserMessage(text: string, tag?: MessageSubtype, messageId?: string): void {
    this.context.addDurableUserMessage(text, tag, messageId);
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }

  appendConversationEntry(
    entry: ConversationWriteEntry,
    metadata?: ConversationAppendMetadata
  ): void {
    this.conversationStore.append(this.mainAgentId, this.id, entry, metadata);
  }

  getInference(): AgentInferencePort {
    return this.inference;
  }

  getSkillCatalog(): SkillCatalogPort | null {
    return this.pilotPorts?.skills ?? null;
  }

  getBrowserControl(): BrowserControlPort | null {
    return this.pilotPorts?.browser ?? null;
  }

  getMailbox(): AgentMailbox {
    return this.mailbox;
  }

  getModule<T extends AgentModule>(name: string): T | undefined {
    return this.modules.find((m) => m.name === name) as T | undefined;
  }

  /**
   * 升级直达通道：经构造时注入的 onFatalTeardown 回调直达 Service。
   * 不经 Mailbox（升级场景恰是"本 runtime 可能出事了"）；未注入（测试/独立构造）降级为日志。
   */
  reportFatalTeardown(error: unknown): void {
    const onFatalTeardown = this.options.onFatalTeardown;
    if (onFatalTeardown) {
      onFatalTeardown(error);
    } else {
      appLog.error({
        event: 'agent.teardown.report.failed',
        message: 'Fatal agent teardown reporting failed',
        context: { scope: 'agent.teardown', agentId: this.id },
        error,
      });
    }
  }

  /** 子代理配置（仅由父创建的 worker 存在）；父收集 children 状态依赖此访问器 */
  getSubagentConfig(): SubagentConfig | undefined {
    return this.options.subagentConfig;
  }

  getSkillDocs(): string {
    return this.skillDocs;
  }

  setSkillDocs(docs: string): void {
    this.skillDocs = docs;
  }

  // ============================================================
  // AgentEngine 抽象方法实现
  // ============================================================

  buildSystemPrompt(): string {
    // 用户自定义指令（AgentRunConfig.systemPrompt / 自定义类型 systemPromptPrefix）不再前缀拼接，
    // 经 ctx.userInstructions 由 assemble() 渲染进 <user_instructions> 槽位
    const ctx = this.buildPromptContext();
    return this._spec.buildSystemPrompt(ctx);
  }

  getControlState(): AgentControlState {
    const runConfig = this.options.runConfig;
    const firstApproval = this.pendingApprovals.values().next();
    const pendingToolCall = firstApproval.done ? undefined : firstApproval.value.pending;

    // 收集子 Agent 状态
    const children: ChildControlState[] = [];
    for (const mod of this.modules) {
      const modChildren = mod.listChildAgents?.() ?? [];
      for (const child of modChildren) {
        const childState = (child as any).getControlState?.() as AgentControlState | undefined;
        if (childState) {
          const childConfig = (child as AgentRuntime).getSubagentConfig?.();
          const childBrowserMod = (child as any).getModule?.('browser') as
            | { getBrowserReady(): boolean; getBrowserId(): string; config: { skills?: string[] } }
            | undefined;
          children.push({
            id: childState.agentId,
            phase: childState.phase,
            interrupted: childState.interrupted,
            mode: (childConfig?.mode as SubagentMode | undefined) || 'browser',
            subject: childConfig?.subject || '',
            taskIds: childConfig?.taskIds || [],
            browserReady: childBrowserMod?.getBrowserReady() ?? false,
            currentModel: childState.currentModel,
            approvalMode: childState.approvalMode,
            reasoningOverride: childState.reasoningOverride,
            pendingToolCall: childState.pendingToolCall,
            pendingEvents: childState.pendingEvents,
            // main/child 暴露同一权威请求状态
            aiRequestState: childState.aiRequestState,
            contextUsage: childState.contextUsage,
            activeStartedAt: childState.activeStartedAt,
            activeLlmStartedAt: childState.activeLlmStartedAt,
            activeToolPhaseStartedAt: childState.activeToolPhaseStartedAt,
            runMetrics: childState.runMetrics,
            conversationLength: childState.conversationLength,
            browserId: childBrowserMod?.getBrowserId(),
            skills: childBrowserMod?.config?.skills,
            // Worker 图片审核节点：child 自身 ImageModule 的即时投影
            imageNodes: childState.imageNodes,
            mcp: childState.mcp,
          });
        }
      }
    }

    // AgentModeId + Task Board UI 投影查询
    const planModule = this.getModule('plan') as
      | {
          getMode(): AgentModeId | undefined;
          getTaskBoard(): {
            taskSummary: string;
            items: import('../../shared/types/index.js').TaskItem[];
          } | null;
        }
      | undefined;
    const modeId: AgentModeId = planModule?.getMode() || this.options.initialModeId || 'normal';
    const taskBoard = planModule?.getTaskBoard?.() ?? undefined;

    // pendingQuestion 两个来源：ask_user 从尾部未配对 tool_use 纯派生（零权威
    // 内存状态）；MCP elicitation 挂起的问题来自服务器瞬时响应，只存在于
    // 进程内续跑记录（重启即作废）。同一时刻至多一个 pending。
    const pendingAsk = getValidPendingAskUser(this.context.getAllMessages());
    const pendingContinuation =
      !pendingAsk && this.pendingToolContinuation && !this.pendingToolContinuation.answers
        ? this.pendingToolContinuation
        : undefined;
    const pendingQuestion: AIQuestion | undefined = pendingAsk
      ? {
          id: pendingAsk.toolUseId,
          agentId: this.id,
          questions: pendingAsk.input.questions,
          timestamp: new Date(),
        }
      : pendingContinuation
        ? {
            id: pendingContinuation.toolUseId,
            agentId: this.id,
            questions: pendingContinuation.continuation.questions.map((question) => ({
              question: question.question,
              options: question.options,
              multiSelect: question.multiSelect ?? false,
            })),
            timestamp: new Date(),
          }
        : undefined;

    return {
      agentId: this.id,
      phase: this.phase,
      interrupted: this.interrupted,
      currentModel: this.currentModel,
      reasoningOverride: this.reasoningOverride,
      approvalMode: this.approvalMode,
      modeId,
      pendingToolCall,
      pendingQuestion,
      pendingEvents: this.mailbox.snapshot().map(projectPendingEvent),
      aiRequestState: this.aiRequestState,
      contextUsage: this.getContextUsage(),
      ...this.getActivityState(),
      conversationLength: this.conversationStore.count(this.mainAgentId, this.id),
      children,
      agentSpec: this._spec.name,
      runConfig: runConfig ?? defaultRunConfig(this._spec.name),
      createdAt: this.createdAt.toISOString(),
      taskBoard: taskBoard || undefined,
      // 每次从 ImageModule 即时派生轻量投影，不维护第二份 Map、不广播 base64
      imageNodes: this.getImageModule()?.getPublicState(),
      mcp: this.mcpSession?.view(),
    };
  }

  /**
   * 应用一批 Mailbox 事件到上下文。
   * 只由 engine 的 applyEventBatch 调用，由该入口统一包装错误并附上本批 event ids；
   * 应用失败即冲程 fatal——内容正确性由生产边界保证，不做逐事件隔离。
   */
  protected applyEvents(events: AgentInputEvent[]): void {
    for (const event of events) {
      // 配对判断前置于模块循环——配对是协议规则，不是 default 兜底；
      // 模块按 content 形状识别、不查 event.source，不能依赖"恰好没有模块认领"
      if (event.source === 'user' && this.tryPairPendingContinuation(event)) {
        continue;
      }
      if (event.source === 'user' && this.tryPairPendingAskUser(event)) {
        continue;
      }
      let consumed = false;
      for (const mod of this.modules) {
        if (mod.processEvent?.(event)) {
          consumed = true;
          break;
        }
      }
      if (!consumed) {
        this.defaultProcessEvent(event);
      }
    }
  }

  /**
   * 消费侧配对（实时回答与历史恢复字面同一段代码）：
   * 尾部存在合法 pending ask_user 时，用户事件结算为该 tool_use 的 tool_result。
   * **消费条件 = 'inserted'**：already_settled / unresolvable 落回普通用户消息路径
   * （由 defaultProcessEvent 投影为普通消息）——损坏档案下不吞消息、不永久等待。
   * 配对成功后该事件只产生 tool_result：不进 module、不写普通消息。
   */
  /**
   * MCP elicitation 挂起的答案配对：答案不直接成为 tool_result，而是记入
   * 续跑记录——冲程循环在下一个模型边界前喂回在途请求（resumeToolContinuation）。
   * 面板多答案按问题序对应；纯文本回答映射为单问题答案。
   * 数目不匹配的面板提交丢弃并告警（与 ask_user 同一纪律），事件落回普通路径。
   */
  private tryPairPendingContinuation(event: AgentInputEvent): boolean {
    const pending = this.pendingToolContinuation;
    if (!pending || pending.answers) return false;
    if (
      resolveToolUseSettlement(this.context.getAllMessages(), pending.toolUseId) !== 'insertable'
    ) {
      return false;
    }

    const questionCount = pending.continuation.questions.length;
    let answers: string[] | undefined;
    if (event.uiSubmission?.kind === 'ask_user_answer') {
      if (event.uiSubmission.answers.length === questionCount) {
        answers = [...event.uiSubmission.answers];
      } else {
        appLog.warn({
          event: 'agent.answer_pairing.validate.rejected',
          message: 'Agent answer submission rejected',
          context: {
            scope: 'agent.answer_pairing',
            agentId: this.id,
            toolUseId: pending.toolUseId,
            questionCount,
            answerCount: event.uiSubmission.answers.length,
            answerSource: 'continuation',
            reason: 'answer_count_mismatch',
          },
        });
        return false;
      }
    } else if (questionCount === 1) {
      answers = [typeof event.content === 'string' ? event.content : JSON.stringify(event.content)];
    } else {
      // 多问题只接受面板结构化提交，散文本落回普通消息路径
      return false;
    }

    pending.answers = answers;
    this.emitStateChange();

    return true;
  }

  private tryPairPendingAskUser(event: AgentInputEvent): boolean {
    const pending = getValidPendingAskUser(this.context.getAllMessages());
    if (!pending) return false;

    const text = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
    const images = event.images
      ?.filter((image) =>
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.media_type)
      )
      .map((image) => ({
        base64: image.data,
        mediaType: image.media_type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      }));

    // ask_user_answers 协议生产点：仅当旁路答案数与问题数一致才
    // 构造 artifact；不匹配时文本结算照常进行，不截断、不补空、不部分配对。
    const answers =
      event.uiSubmission?.kind === 'ask_user_answer' &&
      event.uiSubmission.answers.length === pending.input.questions.length
        ? event.uiSubmission.answers
        : undefined;
    if (event.uiSubmission?.kind === 'ask_user_answer' && !answers) {
      appLog.warn({
        event: 'agent.answer_pairing.validate.rejected',
        message: 'Agent answer submission rejected',
        context: {
          scope: 'agent.answer_pairing',
          agentId: this.id,
          toolUseId: pending.toolUseId,
          questionCount: pending.input.questions.length,
          answerCount: event.uiSubmission.answers.length,
          answerSource: 'ask_user',
          reason: 'answer_count_mismatch',
        },
      });
    }
    const artifacts: ToolArtifact[] | undefined = answers
      ? [{ kind: 'ask_user_answers', payload: { answers: [...answers] } }]
      : undefined;

    const settled = this.settler.settleLive({
      kind: 'answer',
      callId: pending.toolUseId,
      toolName: 'ask_user',
      text,
      images,
      artifacts,
    });
    if (settled !== 'inserted') return false;

    return true;
  }

  /**
   * 冲程失败出口：基础设施失败的终态通知——运行时对自身的失败负责。
   * AI 请求耗尽/上下文构建失败/工具管线崩溃时 AI 已无机会调用 send_event(failed)：
   * - worker：运行时代发 failed 通知父流程（origin: 'runtime'，附错误摘要与受影响批次 event ids），
   *   否则父 director 收不到任何终态事件，worker 悬挂到 stalled 看门狗分钟级兜底；
   * - director：记 AgentIncident 供 UI 展示终态错误，INERT 等用户追加指令重启新冲程。
   * 契约：同步无抛（launchPump 出口 handler），可观测性/通知故障就地吞并记录。
   */
  protected override handlePumpFailure(error: unknown): void {
    super.handlePumpFailure(error);

    const message = error instanceof Error ? error.message : String(error);
    const eventIds = error instanceof EventBatchApplyError ? error.eventIds : undefined;

    // AgentIncident 组合规则：记录方（callAI 的 catch）抛
    // RecordedAIRequestError 类型凭据 = 该失败已写入唯一一条最终 AgentIncident，
    // 此处只认类型不比实例，其余 fatal 才记 system 条目
    if (!(error instanceof RecordedAIRequestError)) {
      try {
        agentIncidentStore.raise({
          severity: 'error',
          category: 'system',
          source: this.incidentTarget,
          message: `Agent 执行故障：${message}`,
          originalError: message,
          context: eventIds ? { eventIds } : undefined,
        });
      } catch (logError) {
        appLog.error({
          event: 'logging.error_entry.persist.failed',
          message: 'Agent error entry persistence failed',
          context: { scope: 'logging.error_entry', agentId: this.id },
          error: logError,
        });
      }
    }

    if (this._spec.role === 'worker') {
      try {
        const onNotification = (this.options as { onNotification?: NotificationDelivery })
          .onNotification;
        if (onNotification) {
          onNotification({
            type: 'failed',
            // AI provider messages remain byte-for-byte display text; runtime
            // failures keep the local prefix because they have no provider body.
            error: error instanceof RecordedAIRequestError ? message : `运行时故障：${message}`,
            data: { origin: 'runtime', ...(eventIds ? { eventIds } : {}) },
            ...(error instanceof RecordedAIRequestError && {
              failure: {
                errorType: error.failure.errorType,
                ...(error.failure.diagnostics && { diagnostics: error.failure.diagnostics }),
              },
            }),
          });
        } else {
          appLog.warn({
            event: 'agent.failure_notification.deliver.skipped',
            message: 'Agent failure notification was not delivered',
            context: {
              scope: 'agent.failure_notification',
              agentId: this.id,
              reason: 'missing_callback',
            },
          });
        }
      } catch (notifyError) {
        appLog.error({
          event: 'agent.failure_notification.deliver.failed',
          message: 'Agent failure notification failed',
          context: { scope: 'agent.failure_notification', agentId: this.id },
          error: notifyError,
        });
      }
    }
  }

  /** 冲程 turn 配置：工具钩子按冲程创建，executeMode 可在每个工具批次前实时求值。 */
  protected override getTurnConfig(): TurnConfig {
    const loopConfig = this.role.configureLoop(this);
    return {
      executeMode: loopConfig.executeMode,
      onBeforeExecuteTools: loopConfig.onBeforeExecuteTools as TurnConfig['onBeforeExecuteTools'],
      onAfterExecute: loopConfig.onAfterExecute as TurnConfig['onAfterExecute'],
    };
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 环境准备：工具链 + Role 启动逻辑 + Module 启动。
   * 不启动循环 —— resume(autoStart=false) 场景也必须完整执行，
   * 否则后续 injectEvent 重启循环时工具链是空的。
   */
  async prepare(): Promise<void> {
    if (this.prepared) return;
    this.prepared = true;

    if (this._spec.name === 'browser-skill-verifier') {
      this.browserSkillCandidatePin = browserSkillCandidateOverlay.pin(this.mainAgentId, this.id);
    }

    try {
      // 每个 Runtime 使用独立的系统临时目录，避免运行时文件污染用户工作区。
      await pathsService.ensureTempDir(this.id);

      // 1. Role 启动逻辑（isResume 时 Role 内部跳过初始任务注入）
      await this.role.onStart(this, this.options);

      // 2. Module 启动
      for (const mod of this.modules) {
        await mod.onStart?.();
      }

      // 3. 建立本 Runtime 独占的 MCP Session。能力求值失败也只降级为无 MCP 工具面。
      try {
        await this.prepareMcpSession();
      } catch (error) {
        appLog.warn({
          event: 'agent.mcp_session.prepare.degraded',
          message: 'Agent MCP session preparation degraded',
          context: { scope: 'agent.mcp_session', agentId: this.id },
          error: sanitizeMcpErrorText(error, { maxLength: 2_048 }),
        });
      }

      // 4. 资源已建立后冻结 activation，并接入进程级 Catalog。
      const activation = this.createToolContext();
      const { getStandaloneToolCatalog } = await import('../tools/index.js');
      const catalog = this.pilotPorts?.skills.getToolCatalog() ?? getStandaloneToolCatalog();
      this.initToolExecution(catalog, this.createToolFace(activation), activation);
    } catch (error) {
      if (this.browserSkillCandidatePin) {
        browserSkillCandidateOverlay.releasePin(this.mainAgentId, this.id);
        this.browserSkillCandidatePin = undefined;
      }
      throw error;
    }
  }

  /**
   * Main 从磁盘配置求值能力；Worker 只能收窄 Main 创建时的能力快照。
   * Manager 返回 handle 后立即 startAll，但 startAll 不 await 任何网络任务。
   */
  private async prepareMcpSession(): Promise<void> {
    const [runtimeModule, injectionModule, sessionModule] = await Promise.all([
      import('../mcp/runtime/index.js'),
      import('../mcp/bridge/injection.js'),
      import('./mcp-session.js'),
    ]);
    const { resolveContextWindow } = await import('../core/pilot/skill-inventory.js');
    const contextWindowTokens = resolveContextWindow(this);
    const isWorker = this._spec.role === 'worker';
    const runSelection = this.options.runConfig?.mcpServers;
    const selection = isWorker
      ? this._spec.mcpServers
      : injectionModule.intersectMcpSelections(
          Array.isArray(runSelection) ? (runSelection as string[]) : undefined,
          this._spec.mcpServers
        );
    const parentCapability = this.options.parentMcpCapability as McpCapabilitySnapshot | undefined;
    const input: import('../mcp/runtime/manager.js').CreateMcpSessionInput = {
      ownerId: this.id,
      ownerKind: isWorker ? 'worker' : 'main',
      ownerLabel: isWorker
        ? this.options.subagentConfig?.subject || this._spec.name
        : this.options.runConfig?.name || this._spec.name,
      workspace:
        (this.options.runConfig?.workspace as string | undefined) ??
        (this.options.workspace as string | undefined),
      selection,
      ...(isWorker ? (parentCapability ? { parentCapability } : { servers: [] }) : {}),
    };
    if (isWorker && !parentCapability) {
      appLog.warn({
        event: 'agent.mcp_capability.inherit.degraded',
        message: 'Worker MCP capability inheritance degraded',
        context: {
          scope: 'agent.mcp_capability',
          agentId: this.id,
          reason: 'missing_parent_snapshot',
        },
      });
    }

    let handle =
      !isWorker && this.options.mcpPrewarmToken
        ? await runtimeModule.mcpConnectionManager.adoptPrewarm(this.options.mcpPrewarmToken, input)
        : null;
    handle ??= await runtimeModule.mcpConnectionManager.createSession(input);
    const budgetRatio = handle.capability.contextBudgetRatio;
    this.mcpSession = new sessionModule.AgentMcpSession(handle, contextWindowTokens, budgetRatio);
    this.unsubscribeMcp = this.mcpSession.onChange(() => this.emitStateChange());
    this.mcpSession.startAll();
  }

  /** SubagentModule 只传能力快照，绝不把 Main 的 live handle 传给 Worker。 */
  getMcpCapabilitySnapshot(): McpCapabilitySnapshot | undefined {
    return this.mcpSession?.capability;
  }

  protected override async advanceModelBoundary(signal: AbortSignal): Promise<void> {
    if (!this.mcpSession) return;
    try {
      await this.mcpSession.advanceBoundary(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      appLog.warn({
        event: 'agent.mcp_projection.advance.degraded',
        message: 'Agent MCP projection advance degraded',
        context: { scope: 'agent.mcp_projection', agentId: this.id },
        error: sanitizeMcpErrorText(error, { maxLength: 2_048 }),
      });
    }
  }

  protected override captureCatalogSnapshot(): CatalogSnapshot {
    const candidate = canAccessBrowserSkillCandidate(this._spec.name)
      ? (this.browserSkillCandidatePin?.candidate ??
        browserSkillCandidateOverlay.candidate(this.mainAgentId, undefined, this.id))
      : undefined;
    return this.toolCatalog.snapshot(this.toolFace, {
      entries: [...(this.mcpSession?.snapshot().entries ?? []), ...(candidate?.entries ?? [])],
      replaceSkills: candidate ? [candidate.skillName] : undefined,
    });
  }

  protected override getModelBoundaryRevision(): number {
    const mcpRevision = this.mcpSession?.snapshot().revision ?? 0;
    const candidateAllowed = canAccessBrowserSkillCandidate(this._spec.name);
    const candidateRevision = candidateAllowed
      ? (this.browserSkillCandidatePin?.revision ??
        browserSkillCandidateOverlay.snapshot(this.mainAgentId)?.revision ??
        0)
      : 0;
    const candidateId = candidateAllowed
      ? (this.browserSkillCandidatePin?.candidate.id ??
        browserSkillCandidateOverlay.candidate(this.mainAgentId)?.id ??
        '')
      : '';
    const key = `${mcpRevision}:${candidateRevision}:${candidateId}`;
    if (key !== this.modelBoundaryProjectionKey) {
      this.modelBoundaryProjectionKey = key;
      this.modelBoundaryProjectionRevision += 1;
    }
    return this.modelBoundaryProjectionRevision;
  }

  async start(): Promise<void> {
    await this.prepare();

    // start 也是一条 Mailbox 输入：首次启动与后续恢复走同一条链路
    this.postSystemEvent('start');
  }

  /**
   * 中断后钩子（基类 interrupt 在 join + pending ask 结算后调用，
   * 复用为最终广播）：role 收尾（如 director 写 header 快照）。不覆写公共 interrupt——
   * 丢弃/abort/cancelInFlightWork 的唯一实现在基类（override 回潮锁定测试兜底）。
   * try/finally：writeHeader 抛错不得吞掉基类最终 emitStateChange——
   * 否则 ask 已在内存结算而面板残留（外层照旧记录 role 钩子错误）。
   */
  protected override onAfterInterrupt(): void {
    try {
      this.role.onAfterInterrupt(this);
    } finally {
      super.onAfterInterrupt();
    }
  }

  /**
   * 恢复尾部修复：replay 之后在内存上执行，与实时模型边界守卫
   * 同一函数、同一分类（reconcileLatestToolBatch）；合法 pending ask 保持未配对
   * （incoming 用户消息完成它），有修复写入则落盘。由 AgentService 恢复事务调用。
   */
  repairConversationTail(): void {
    const { wrote } = this.reconcileLatestToolBatch('recovery');
    if (wrote) {
      this.context.flush();
    }
  }

  /** 取消在途工作（interrupt 与 destroy 同步关门共用）：模块级 sync waiter 等 */
  protected override cancelInFlightWork(): void {
    if (this.destroyPromise && this.pendingToolContinuation) {
      const pending = this.pendingToolContinuation;
      this.pendingToolContinuation = undefined;
      try {
        pending.continuation.cancel();
      } catch {
        // Session release below remains the authoritative connection-level cancellation.
      }
    }
    for (const mod of this.modules) {
      try {
        mod.onInterrupt?.();
      } catch (error) {
        appLog.warn({
          event: 'agent.module.interrupt.degraded',
          message: 'Agent module interrupt degraded',
          context: { scope: 'agent.module', agentId: this.id, moduleName: mod.name },
          error,
        });
      }
    }
  }

  /**
   * 边界终止任务（destroy 同步前缀当场 allSettled 消费）：
   * 每模块 onDestroyBegin 单独捕获同步 throw 转为 rejection，单模块失败不阻断其余发起。
   */
  protected override collectDestroyBeginTasks(): Array<Promise<unknown>> {
    const moduleTasks = this.modules
      .filter((m) => m.onDestroyBegin)
      .map((m) => {
        try {
          return { module: m, promise: Promise.resolve(m.onDestroyBegin!()) };
        } catch (error) {
          return { module: m, promise: Promise.reject(error) };
        }
      });
    const tasks = moduleTasks.map(({ promise }) => promise);
    this.unsubscribeMcp?.();
    this.unsubscribeMcp = undefined;
    if (this.mcpSession) {
      const session = this.mcpSession;
      const childTeardown = moduleTasks
        .filter(({ module }) => module.name === 'subagent')
        .map(({ promise }) => promise);
      tasks.push(Promise.allSettled(childTeardown).then(() => session.release()));
    }
    return tasks;
  }

  /** 模块级销毁任务；finishDestroy 以 allSettled 消费，单个失败不阻断其余任务。 */
  protected override collectDestroyTasks(): Array<Promise<unknown>> {
    // Pump 已退场，Verifier 不再可能读 candidate；此逻辑锁不应因浏览器清理失败泄漏。
    if (this.browserSkillCandidatePin) {
      browserSkillCandidateOverlay.releasePin(this.mainAgentId, this.id);
      this.browserSkillCandidatePin = undefined;
    }
    // Candidate 是 AgentRun-local 内存投影，不是需要在 teardown 失败时保留的资源租约。
    // Director 一旦销毁，本次构建运行已经结束；即使某个模块清理失败也必须撤掉投影。
    if (this._spec.name === 'browser-skill-director') {
      browserSkillCandidateOverlay.clear(this.mainAgentId);
    }
    const tasks = this.modules
      .map((m) => m.onDestroy?.())
      .filter((p): p is Promise<void> => p !== undefined);
    if (this.backgroundRegistry) tasks.push(this.backgroundRegistry.dispose());
    return tasks;
  }

  /**
   * 占用释放唯一写入点：模块永不直接释放；
   * 仅 finishDestroy 在 errors 为空（边界终止有凭据）时调用——
   * errors 非空则占用保留（不释放给其他 AgentRun，失败隔离）。
   */
  protected override async releaseResources(): Promise<void> {
    occupancyRegistry.releaseAllOwnedBy(this.id);
  }

  buildHeader(): AgentRunHeader {
    const runConfig = this.options.runConfig;
    const childSnapshots: ChildSnapshot[] = [];
    for (const mod of this.modules) {
      const children = mod.listChildAgents?.() ?? [];
      for (const child of children) {
        const childRuntime = child as any;
        childSnapshots.push({
          id: childRuntime.id || '',
          config: ((child as AgentRuntime).getSubagentConfig?.() || {}) as SubagentConfig,
          createdAt: childRuntime.createdAt?.getTime?.() || Date.now(),
        });
      }
    }
    return {
      agentId: this.id,
      agentSpec: this._spec.name,
      modeId: this.getControlState().modeId,
      runConfig: runConfig ?? defaultRunConfig(this._spec.name),
      createdAt: this.createdAt.toISOString(),
      lastActiveAt: new Date().toISOString(),
      currentModel: this.currentModel,
      approvalMode: this.approvalMode,
      childAgents: childSnapshots,
    };
  }

  // ============================================================
  // 模块能力冻结后构造 activation 输入；逐调用能力由 context factory 授予。
  // ============================================================

  private createToolContext(): ToolActivationContext {
    const builder = new ToolContextBuilder();

    builder.setModes({
      modeId: () => {
        const plan = this.getModule('plan') as { getMode(): AgentModeId } | undefined;
        return plan?.getMode() ?? 'normal';
      },
      approvalMode: () => this.approvalMode,
    });

    // Role 设置 agentInfo
    this.role.enrichToolContext(builder, this, this.options);

    // Module 贡献工具上下文
    for (const mod of this.modules) {
      mod.contributeTools?.(builder);
    }

    // Runtime 级补充：customTool 白名单 + 工具黑名单。
    const ownCustomTools = this._spec.tools?.customTools;
    if (ownCustomTools) {
      builder.setToolFace(
        this.mergedCustomTools(),
        this._spec.tools?.exclude?.length ? [...this._spec.tools.exclude] : undefined
      );
    } else {
      builder.setToolFace(
        undefined,
        this._spec.tools?.exclude?.length ? [...this._spec.tools.exclude] : undefined
      );
    }

    const typed = builder.build();
    const info = typed.agentInfo;
    const runConfig = info.runConfig ?? defaultRunConfig(this._spec.name);
    const workspaceDir =
      runConfig.workspace ??
      (this.options.workspace as string | undefined) ??
      pathsService.getDefaultWorkspaceDir();

    return {
      agentType: info.role === 'worker' ? 'worker' : 'main',
      agentSpec: info.agentSpec,
      agentId: info.agentId,
      mainAgentId: info.mainAgentId,
      runConfig: Object.freeze({ ...runConfig }),
      subagentConfig: info.subagentConfig,
      resourceIds: typed.resourceIds,
      assignmentSnapshot: typed.assignmentSnapshot,
      skillInventory: typed.skillInventory,
      currentModel: () => this.currentModel,
      workspace: Object.freeze({ dir: workspaceDir, tempDir: pathsService.getTempDir(this.id) }),
      modes: typed.modes,
      taskBoard: typed.taskBoard,
      plan: typed.plan,
      subagents: typed.subagents,
      events: typed.events,
      imageOps: typed.imageOps,
      browser: typed.browser,
      post: (event) => {
        if (info.role === 'worker' && event.source === 'subagent') {
          if (typeof event.content === 'string') return false;
          return (
            typed.events?.notifyParent(event.content as unknown as SubagentNotification) ?? false
          );
        }
        return this.post(event);
      },
    };
  }

  // ============================================================
  // 提示词上下文
  // ============================================================

  /** 最终 custom 工具面（常量工具面）：spec.customTools − spec.exclude。 */
  private mergedCustomTools(): string[] {
    const excluded = new Set(this._spec.tools?.exclude ?? []);
    return [...new Set(this._spec.tools?.customTools ?? [])].filter((name) => !excluded.has(name));
  }

  private buildPromptContext(): PromptContext {
    const ctx: PromptContext = {
      agentId: this.id,
      role: 'director',
      runName: this._spec.name,
      canManageAgentRuns: this.getAvailableTools().some((tool) => tool.name === 'agent_run'),
      skillDocs: this.skillDocs,
      workspaceDir: pathsService.getDefaultWorkspaceDir(),
      tempDir: pathsService.getTempDir(this.id),
    };

    // Role 扩展提示词上下文
    this.role.enrichPromptContext(ctx, this, this.options);

    const mcpBlock = this.mcpSession?.snapshot().promptBlock;
    if (mcpBlock) {
      ctx.mcpBlock = mcpBlock;
    }

    return ctx;
  }

  // ============================================================
  // SDK 技能和自定义工具组
  // ============================================================

  private getSdkSkillsToLoad(): string[] {
    return [...(this._spec.tools?.sdkGroups ?? [])];
  }

  private createToolFace(activation: ToolActivationContext): FinalToolFace {
    const sdkGroups = this.getSdkSkillsToLoad();
    const customTools = [...new Set([...this.mergedCustomTools(), 'load_skill', 'skill_call'])];
    const domains = new Set<'local' | 'browser'>(['local']);
    if (activation.resourceIds.browserId && activation.browser) domains.add('browser');
    const metadata = activation.runConfig?.bindings;
    const browserEnvironmentIds =
      metadata?.type === 'standard' && Array.isArray(metadata.boundEnvironmentIds)
        ? metadata.boundEnvironmentIds.filter(
            (id): id is string => typeof id === 'string' && id.length > 0
          )
        : [];
    return Object.freeze({
      scope: activation.agentType === 'worker' ? 'subagent' : 'main',
      agentType: activation.agentType,
      customTools: Object.freeze(customTools),
      exposedSkillFunctions: Object.freeze(
        this.pilotPorts?.skills.getDirectSkillToolNames(sdkGroups) ?? []
      ),
      excluded: new Set(this._spec.tools?.exclude ?? []),
      domains,
      subagentTypes: Object.freeze(specRegistry.getNamedWorkersForParent(this._spec.name)),
      subagentResources: Object.freeze({
        browserEnvironmentIds: Object.freeze([...new Set(browserEnvironmentIds)]),
      }),
    });
  }

  // ============================================================
  // Incident target
  // ============================================================

  private buildRuntimeIncidentTarget(): AgentTarget {
    return this._spec.role === 'worker'
      ? { agentId: this.options.mainAgentId, workerId: this.id }
      : { agentId: this.id };
  }

  // ============================================================
  // 内容观察（由创建该 Runtime 的 owner 注入）
  // ============================================================

  protected override emitContentEvent(event: AgentContentEvent): void {
    this.runtimeObserver?.contentProduced(event);
  }

  protected override emitLiveContent(event: AgentLiveContentDelta): void {
    this.runtimeObserver?.liveContentProduced(event);
  }

  // ============================================================
  // 子 Agent 查询（真实 Worker 由模块拥有）
  // ============================================================

  override listChildAgents(): AgentEngine[] {
    return this.modules.flatMap((module) => module.listChildAgents?.() ?? []);
  }

  protected override buildInterruptionResumeEvents(): AgentInputRequest[] {
    const mod = this.getModule('subagent') as
      | { buildUserInterruptedWorkersEvent(): AgentInputRequest | undefined }
      | undefined;
    const event = mod?.buildUserInterruptedWorkersEvent();
    return event ? [event] : [];
  }

  // ============================================================
  // 默认事件处理
  // ============================================================

  private defaultProcessEvent(event: AgentInputEvent): void {
    // 空内容守卫收窄：正文与 images 都为空才忽略——私聊纯图片是合法输入
    const hasImages = (event.images?.length ?? 0) > 0;
    if (!event.content && !hasImages) return;

    // 系统事件（postSystemEvent factory）：
    // start 是纯触发器（初始上下文已由 role.onStart 注入，不重复落痕）；
    // start 是唯一的系统触发事件；后台完成有自己的持久化通知形状。
    if (event.source === 'system' && typeof event.content === 'object') {
      const content = event.content as Record<string, unknown>;
      if (content.type === 'start') return;
      if (content.kind === 'background_task_done') {
        this.settler.notify(
          event.content as import('./conversation/model-text.js').BackgroundDoneEvent
        );
        return;
      }
    }

    const contentStr =
      typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
    // 事件信封：source=user → 裸文本（cc 式：默认即用户、注入才带标签）；其余 → <agent_input>
    // ts 属性 = 时间锚点（细粒度时间戳在信封，<current_time> 保持日粒度护 prompt cache）
    const subtype = event.source === 'user' ? 'user_input' : 'system_event';
    const ts = new Date(event.timestamp).toISOString();
    const messageText =
      subtype === 'user_input'
        ? contentStr
        : `<agent_input source="${event.source}"${event.priority === 'high' ? ' priority="high"' : ''} ts="${ts}">\n${neutralizeClosing('agent_input', contentStr)}\n</agent_input>`;

    this.addUserMessage({ text: messageText, images: event.images, subtype });
  }

  // ============================================================
  // 对话重放（Resume 用，由 AgentService 调用）
  // ============================================================

  async replayConversation(entries: ConversationEntry[]): Promise<void> {
    let lastSummaryIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].t === 'summary') {
        lastSummaryIdx = i;
        break;
      }
    }
    const replayFrom = lastSummaryIdx >= 0 ? lastSummaryIdx : 0;
    const toReplay = entries.slice(replayFrom);

    // 回放内容来自磁盘，挂起 flush 避免写回；结束后全部标记为已持久化
    this.context.beginReplay();
    try {
      // model / approvalMode 从 header 恢复；思考强度在每次恢复时从最新模型配置重新取快照，
      // 因此历史 reasoning marker 一律不重演。
      for (const entry of entries) {
        if (entry.t === 'marker') this.replayDurableMarker(entry.key, entry.value);
      }
      await this.doReplay(toReplay);
    } finally {
      this.context.endReplay();
    }
  }

  private async doReplay(toReplay: ConversationEntry[]): Promise<void> {
    for (const entry of toReplay) {
      switch (entry.t) {
        case 'summary':
          this.context.restoreSummary(entry.summary);
          break;
        case 'msg': {
          const content = await this.conversationStore.materializeMessageContent(
            this.mainAgentId,
            this.id,
            entry.content
          );
          if (entry.role === 'user') {
            this.context.addUserMessage(content, entry.subtype);
          } else {
            this.context.addAssistantMessage(
              typeof content === 'string' ? [{ type: 'text', text: content }] : content
            );
          }
          break;
        }
        case 'tool':
          // tool results 重建：materialize（image_ref 读 blob 转 base64，
          // 多模态保真）→ settleRecovery 确定性清理——同一 call 多个 result 保留第一条
          // （already_settled）、反向孤儿不插入（unresolvable），均记 error 日志
          if (entry.toolUseId && entry.result) {
            const blocks = await this.conversationStore.materializeToolResultBlocks(
              this.mainAgentId,
              this.id,
              entry.result
            );
            const settled = this.settler.settleRecovery({
              conversationId: this.id,
              callId: entry.toolUseId,
              blocks,
              ok: entry.ok,
            });
            if (settled !== 'inserted') {
              appLog.warn({
                event: 'agent.conversation.replay.degraded',
                message: 'Conversation replay skipped an invalid tool result',
                context: {
                  scope: 'agent.conversation',
                  agentId: this.id,
                  toolUseId: entry.toolUseId,
                  reason: settled,
                },
              });
            }
          }
          break;
        case 'marker':
          // marker 已由 replayConversation 的全量分类回放处理（见其注释），此处不再重复
          break;
      }
    }
  }

  /** 历史 marker 不参与当前运行态；恢复时由 header 与最新模型配置建立新快照。 */
  private replayDurableMarker(key: string, value: unknown): void {
    // 全部 marker 只读忽略：
    // model / approvalMode：header 一次性恢复
    // reasoningOverride / reasoningByModel：活跃期快照，不跨恢复重演
    // child_created / child_stopped：记录型 marker，无恢复动作
    void key;
    void value;
  }

  // ============================================================
  // 便捷代理方法（供 AgentService / IPC 调用）
  // ============================================================

  // ── 确认模式 ──

  public override setApprovalMode(mode: ApprovalMode): void {
    super.setApprovalMode(mode);
  }

  // 计划获批后由 PlanTool 经 PlanPort 恢复进入计划前的模式。

  // ── 子流程操作 ──

  async instantInterruptSubagent(subagentId: string): Promise<boolean> {
    const mod = this.getModule('subagent') as
      { interruptChildImmediately(id: string): Promise<boolean> } | undefined;
    return mod?.interruptChildImmediately(subagentId) ?? false;
  }

  setSubagentModel(subagentId: string, model: string): boolean {
    const mod = this.getModule('subagent') as
      { applyChildModel(id: string, model: string): boolean } | undefined;
    return mod?.applyChildModel(subagentId, model) ?? false;
  }

  setSubagentReasoning(
    subagentId: string,
    selection?: import('../../shared/types/reasoning.js').ReasoningSelection
  ): boolean {
    const mod = this.getModule('subagent') as
      | {
          applyChildReasoning(
            id: string,
            value?: import('../../shared/types/reasoning.js').ReasoningSelection
          ): boolean;
        }
      | undefined;
    return mod?.applyChildReasoning(subagentId, selection) ?? false;
  }

  setSubagentApprovalMode(subagentId: string, mode: ApprovalMode): boolean {
    const mod = this.getModule('subagent') as
      { applyChildApprovalMode(id: string, mode: ApprovalMode): boolean } | undefined;
    return mod?.applyChildApprovalMode(subagentId, mode) ?? false;
  }

  respondToSubagentApproval(subagentId: string, decision: ToolApprovalDecision): boolean {
    const mod = this.getModule('subagent') as
      { settleChildApproval(id: string, decision: ToolApprovalDecision): boolean } | undefined;
    return mod?.settleChildApproval(subagentId, decision) ?? false;
  }

  injectEventToSubagent(subagentId: string, event: AgentInputEvent): boolean {
    const mod = this.getModule('subagent') as
      { injectEventToSubagent(id: string, event: AgentInputEvent): boolean } | undefined;
    return mod?.injectEventToSubagent(subagentId, event) ?? false;
  }

  createSubagentNotificationHandler(
    subagentId: string
  ): (notification: SubagentNotification) => boolean {
    const mod = this.getModule('subagent') as
      | { createSubagentNotificationHandler(id: string): (n: SubagentNotification) => boolean }
      | undefined;
    return mod?.createSubagentNotificationHandler(subagentId) ?? (() => false);
  }

  // ── 计划模式 ──

  setMode(mode: AgentModeId): void {
    const mod = this.getModule('plan') as { setMode(mode: AgentModeId): void } | undefined;
    mod?.setMode(mode);
  }

  // ── 图片操作：IPC 只提交审核动作并立即返回；
  //    重生成/commit 等耗时操作全部在原 generate_image 工具 Promise 内执行 ──

  private getImageModule(): ImageModule | undefined {
    return this.getModule('image') as ImageModule | undefined;
  }

  respondToImageApproval(nodeId: string): { success: boolean; error?: string } {
    const mod = this.getImageModule();
    return (
      mod?.submitReviewAction(nodeId, { type: 'approve' }) ?? {
        success: false,
        error: '图片模块未启用',
      }
    );
  }

  enterImageEdit(nodeId: string): { success: boolean; error?: string } {
    const mod = this.getImageModule();
    return mod?.enterImageEdit(nodeId) ?? { success: false, error: '图片模块未启用' };
  }

  regenerateImage(
    nodeId: string,
    imageIds: string[],
    instruction: string,
    target?: import('../inference/execution/contracts.js').ModelTarget,
    images?: Array<{ data: string; media_type: string }>
  ): { success: boolean; error?: string } {
    const mod = this.getImageModule();
    return (
      mod?.submitReviewAction(nodeId, {
        type: 'regenerate',
        imageIds,
        instruction,
        target,
        images,
      }) ?? { success: false, error: '图片模块未启用' }
    );
  }

  cancelImageReview(nodeId: string, reason?: string): { success: boolean; error?: string } {
    const mod = this.getImageModule();
    return (
      mod?.submitReviewAction(nodeId, { type: 'cancel', reason }) ?? {
        success: false,
        error: '图片模块未启用',
      }
    );
  }

  deleteImage(nodeId: string, imageId: string): { success: boolean; error?: string } {
    const mod = this.getImageModule();
    return mod?.deleteImage(nodeId, imageId) ?? { success: false, error: '图片模块未启用' };
  }

  changeImageModel(
    nodeId: string,
    target: import('../inference/execution/contracts.js').ModelTarget
  ): { success: boolean; error?: string } {
    const mod = this.getImageModule();
    return mod?.changeImageModel(nodeId, target) ?? { success: false, error: '图片模块未启用' };
  }
}

function defaultRunConfig(name: string): AgentRunConfig {
  return {
    name,
    description: name,
    promptTemplate: '',
  };
}
