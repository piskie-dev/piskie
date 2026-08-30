import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * AgentEngine — Agent 执行引擎抽象基类
 * 替代 AgentBase。删除状态机，用 AgentPhase 替代 AgentStatus。
 *
 * 核心设计：
 * - 没有 status 字段。运行中 = loopPromise !== null（进程级事实）
 * - phase 是唯一的 UI 指示器（thinking/executing/waiting/stopping）
 * - conversationStore 供子类实现 Write-Before-Emit
 * - 没有 resume() 方法。Resume 是 Service 层操作（创建新 runtime 实例）
 */

import type {
  AgentInferenceBackoff,
  AgentInferenceOptions,
  AgentInferencePort,
  VisibleDelta,
} from '../inference/application/agent-inference-port.js';
import type { AgentLiveContentDelta } from '../../shared/electron-contracts/agents.js';
import type { ModelTarget } from '../inference/execution/contracts.js';
import {
  formatModelTarget,
  parseModelTargetReference,
} from '../inference/execution/model-target.js';
import { normalizeAIRequestFailure, RecordedAIRequestError } from '../core/ai/ai-request-error.js';
import { AgentConversationContext } from './context/index.js';
import {
  AgentMailbox,
  normalizeAgentInputEvent,
  UserInterruptError,
  DisposedError,
  EventBatchApplyError,
} from './agent-mailbox.js';
import { createDeferred } from '../utils/deferred.js';
import {
  createDeferredToolsPort,
  type CatalogSnapshot,
  type FinalToolFace,
} from '../tools/catalog.js';
import { ToolCatalog } from '../tools/catalog.js';
import { ToolCoordinator } from '../tools/coordinator.js';
import type { ToolExecutionInterval, ToolObserver } from '../tools/pipeline/observe.js';
import { BackgroundRegistry } from '../tools/state/background-registry.js';
import { ToolCallContextFactory } from './tool-call/context-builder.js';
import { Settler } from './conversation/settler.js';
import { AgentActivityTracker } from './run-metrics.js';
import { deriveIdlePermits, type IdlePermit } from './idle-permit.js';
import { agentIncidentStore } from '../observability/incidents/agent-incident-store.js';
import type { AgentPilotPorts } from '../core/pilot/index.js';
import type { ConversationStore } from '../agent-runs/conversation-store.js';
import type { AgentTarget } from '../../shared/types/agent-control.js';
import type { ContextSnapshot, ContextUsage } from '../../shared/types/token.js';
import type {
  AgentActivityState,
  AgentPhase,
  AgentControlState,
  ConversationAppendMetadata,
  ConversationWriteEntry,
} from '../../shared/types/agent-control.js';
import { AIErrorType } from '../../shared/constants/index.js';
import {
  type Message,
  type Tool,
  type ContentBlock,
  type ApprovalMode,
  type PendingToolCall,
  type ToolApprovalDecision,
  type AIRequestState,
  type AIResponse,
  type AgentInputEvent,
  type AgentInputRequest,
} from '../../shared/types/index.js';
import type { ReasoningSelection } from '../../shared/types/reasoning.js';
import type { AgentContentEvent, TerminalReason, ToolResult } from '../tools/types.js';
import type { ToolActivationContext } from './tool-call/context-builder.js';
import {
  isToolSuspension,
  toToolResult,
  type ToolOutput,
  type ToolSuspension,
  type ToolSuspensionContinuation,
} from '../tools/types.js';
import {
  ASK_USER_GATE_VIOLATION_TEXT,
  buildToolInterruptionResult,
  getUnsettledValidAskCalls,
  getValidPendingAskUser,
  inspectLatestToolBatch,
  parseAskUserInput,
  resolveToolUseSettlement,
} from './context/conversation-protocol.js';
import { linkAbort } from '../utils/abort.js';
import { isMcpAbortError, sanitizeMcpErrorText } from '../mcp/security/sanitize.js';

// ─── 类型定义 ───────────────────────────────────────────

/**
 * executeTools 的 onBeforeExecute 回调返回值
 * - 'execute': 正常执行此工具
 * - 'skip': 完全跳过（不添加 tool_result）— 仅在外部已处理时使用
 * - 'placeholder': 添加占位 tool_result（status: dispatched）
 */
export type ToolExecuteAction = 'execute' | 'skip' | 'placeholder';

/** executeTools 选项 */
export interface ExecuteToolsOptions {
  mode: 'parallel' | 'sequential';
  onBeforeExecute?: (toolUse: ContentBlock) => ToolExecuteAction;
  onAfterExecute?: (toolUse: ContentBlock, result: ToolResult) => void;
  /**
   * 挂起分流回调（onAfterExecute 双职责拆分）：
   * orphan 集合清理对 result/suspended 都执行，role.onAfterExecute 只接收真实结果——
   * suspended 没有结果，"照常调用"就得伪造 success，假完成从后门回来。
   */
  onSuspended?: (toolUse: ContentBlock) => void;
  /** 冲程取消域：审批门挂起等在途等待服从此 signal */
  signal?: AbortSignal;
}

/**
 * Turn 输出：普通返回表达控制流。
 * 没有 terminalReason = 本轮自然 idle。
 */
export interface TurnOutcome {
  terminalReason?: TerminalReason;
}

/** One immutable protocol view used for both an AI request and its returned tool calls. */
export interface ModelBoundarySnapshot {
  readonly revision: number;
  readonly systemPrompt: string;
  readonly catalog: CatalogSnapshot;
  readonly tools: readonly Tool[];
  readonly loadedDeferredTools: ReadonlySet<string>;
}

type ActiveModelContext = Omit<ContextSnapshot, 'usage'>;

/** 冲程 turn 配置（role.configureLoop 产物；动态执行模式在每个工具批次前求值） */
export interface TurnConfig {
  executeMode?: 'parallel' | 'sequential' | (() => 'parallel' | 'sequential');
  onBeforeExecuteTools?: (toolUses: ContentBlock[]) => void;
  onAfterExecute?: ExecuteToolsOptions['onAfterExecute'];
}

// ─── AgentEngine 抽象类 ──────────────────────────────────

export abstract class AgentEngine {
  // === 核心字段（子类在 constructor 中赋值） ===
  // public 以满足 AgentHost 接口的 readonly 属性约束
  public id!: string;
  public mainAgentId!: string;
  protected inference!: AgentInferencePort;
  protected context!: AgentConversationContext;
  protected toolCatalog!: ToolCatalog;
  protected toolFace!: FinalToolFace;
  protected toolCoordinator!: ToolCoordinator;
  /** 运行段内经 tool_search 装载的 deferred MCP 工具（只增不减；resume 清零重建） */
  protected readonly loadedDeferredTools = new Set<string>();
  /**
   * 带续跑的工具挂起（MCP elicitation/MRTR）：在途请求要求补充用户输入。
   * 进程内瞬时状态——问题来自服务器瞬时响应，无法从消息史纯派生；
   * 重启后在途请求作废，恢复守卫按缺失结果写 interrupted（与协议语义一致）。
   * answers 由用户事件配对写入，冲程循环在下一个模型边界前消费。
   */
  protected pendingToolContinuation?: {
    toolUseId: string;
    toolName: string;
    continuation: ToolSuspensionContinuation;
    answers?: string[];
  };
  protected settler!: Settler;
  protected readonly activityTracker = new AgentActivityTracker();
  protected backgroundRegistry!: BackgroundRegistry;
  protected pilotPorts?: AgentPilotPorts;
  protected conversationStore!: ConversationStore;
  private activeModelContext?: ActiveModelContext;
  public currentModel!: string;
  public currentTarget!: ModelTarget;
  public reasoningOverride!: ReasoningSelection;
  protected readonly reasoningByModel = new Map<string, ReasoningSelection>();
  public approvalMode: ApprovalMode = 'confirm';

  /** 唯一的运行时 UI 指示器 */
  public phase: AgentPhase = 'waiting';

  /** 正常 waiting 无法表达用户中断稳态，因此单独保留这一权威生命周期位。 */
  private _interrupted = false;

  get interrupted(): boolean {
    return this._interrupted;
  }

  /** Mailbox：事件唯一真相源，消费只经 takeEvents() */
  protected readonly mailbox = new AgentMailbox();

  /** Pump 门闩：存在 = 一次工作冲程运行中（唯一并发事实） */
  private pumpPromise: Promise<void> | null = null;

  /**
   * 本冲程取消域：出口分类真相源 + 在途工作统一取消
   * （AI 请求/retry backoff/审批门挂起均服从此 signal）。
   */
  protected pumpController?: AbortController;

  /**
   * destroy 幂等门闩：先于任何回调/trace/abort listener 安装。
   * 同时是唯一关门事实：lifetime 取消域随最后一个冲程外操作退役后，
   * "拆除中"判断直接读取本门闩——它在 destroy 第①步同步安装，
   * 关门只会更早不会更晚；"派生事实优于手动布尔"原则延续。
   */
  protected destroyPromise?: Promise<void>;

  /** 状态变化回调（推送 AgentControlState 给前端） */
  protected stateChangeCallback?: (state: AgentControlState) => void;
  /** AI 请求瞬时状态（权威真相源）：只服务 UI/诊断，不参与控制流 */
  protected aiRequestState?: AIRequestState;
  /** 压缩结束后恢复进入压缩前的请求态；主动压缩通常恢复为静默态。 */
  private requestStateBeforeCompaction?: AIRequestState;
  private publishingCompactionActivity = false;
  /** 并发审批队列 */
  protected pendingApprovals = new Map<
    string,
    {
      pending: PendingToolCall;
      resolve: (d: ToolApprovalDecision) => void;
    }
  >();
  protected skillDocs = '';
  protected incidentTarget!: AgentTarget;

  // === 活跃状态 ===

  /** 冲程运行中：语义是"冲程运行中"，不是"循环存活" */
  get isPumping(): boolean {
    return this.pumpPromise !== null;
  }

  // ============================================================
  // Pump 调度核心
  // ============================================================

  /**
   * 全系统唯一调度守卫：任何人可在任意时刻安全调用，
   * 仅当（未拆除 ∧ 无冲程 ∧ 队列非空）才启动新冲程。
   */
  protected ensurePump(): void {
    if (this.destroyPromise || this.pumpPromise || !this.mailbox.hasEvents()) return;
    this.launchPump();
  }

  /**
   * 启动一次工作冲程（门闩防重复）。
   * 冲程体经微任务启动：若写成 `this.pumpPromise = this.runPump(...)`，JS 会先执行
   * 冲程同步前缀再完成赋值——前缀中任何一步同步触发 post() 都会并发第二个 Pump。
   * `Promise.resolve().then(...)` 保证门闩先于任何冲程代码可见（门闩先行）。
   * 只由 ensurePump() 调用；一切启动（含 start/restart）都是 Mailbox 事件驱动。
   */
  private launchPump(): void {
    if (this.destroyPromise || this.pumpPromise) return;

    const controller = new AbortController();
    this.pumpController = controller;

    this.pumpPromise = Promise.resolve()
      .then(() => this.runPump(controller.signal))
      .catch((error) => {
        // 三出口严格分离：return=yield / 本冲程 signal.aborted=cancelled / 其他=failed。
        // 取消真相源只有本冲程自己的 controller，禁用异常形状推断（isAbortError）。
        // 出口 handler 为同步无抛契约，自身异常就地吞并记录。
        try {
          if (controller.signal.aborted) {
            this.handlePumpCancelled(controller.signal.reason);
          } else {
            this.handlePumpFailure(error);
          }
        } catch (handlerError) {
          appLog.error({
            event: 'agent.pump.failure_handler.failed',
            message: 'Agent pump failure handling failed',
            context: { scope: 'agent.pump', agentId: this.id },
            error: handlerError,
          });
        }
      })
      .finally(() => {
        // 清理必须住在 finally：无论出口路径发生什么，门闩必清、复检必跑
        this.pumpPromise = null;
        this.pumpController = undefined;

        try {
          this.publishInert();
        } catch (error) {
          appLog.error({
            event: 'agent.state.publish.failed',
            message: 'Agent idle state publication failed',
            context: { scope: 'agent.state', agentId: this.id },
            error,
          });
        }

        // 复检无条件：守卫（disposed/门闩/队列非空）集中在 ensurePump 一处
        this.ensurePump();
      });
  }

  /** 冲程结束边界的状态发布：turn_end + 回待命态 + 上下文兜底刷盘 */
  protected publishInert(): void {
    // 'stopping' 仅是中断进行中的瞬态，不能滞留——否则中断完成的会话在 UI 上永远显示"停止中"
    this.phase = 'waiting';
    this.activityTracker.activityStopped();
    this.emitContentEvent({ type: 'turn_end' });
    this.context.flush();
    this.emitStateChange();
  }

  /** 冲程取消出口（用户中断 / destroy）：只记录取消原因，不发布 failed */
  protected handlePumpCancelled(_reason: unknown): void {}

  /**
   * 冲程失败出口：真正的基础设施失败。不主动重启冲程，
   * 恢复交给 finally 复检对新事实的正常响应。
   * worker 在此由运行时代发 failed 通知父流程。
   */
  protected handlePumpFailure(error: unknown): void {
    appLog.error({
      event: 'agent.pump.run.failed',
      message: 'Agent pump failed',
      context: { scope: 'agent.pump', agentId: this.id },
      error,
    });
  }

  // === 冲程体（run-to-yield，没有 while 循环、没有 mailbox.wait） ===

  /**
   * 一次工作冲程：吸收事件 → 应用 → runTurn → yield 收尾。
   * 任何 yield（terminal/挂起/自然 idle）都在此返回，冲程结束；
   * 期间到达的新事件由 finally 复检接手。abort 以异常离开，由出口分类处置。
   */
  protected async runPump(signal: AbortSignal): Promise<void> {
    // Mailbox is the only event source for a new activation.
    const events = this.takeEvents();
    if (events.length === 0) return; // ensurePump 守卫后仍可能空批：守卫检查与微任务启动之间 interrupt 可丢弃队列

    // 抛异常即冲程 fatal：内容正确性在生产边界保证
    this.applyEventBatch(events);

    const config = this.getTurnConfig();
    await this.runTurn(signal, config);
    signal.throwIfAborted();
  }

  /**
   * applyEvents 的唯一调用面（runPump 与 runTurn 共用）：
   * 任何一处应用失败，异常都携带本批 event ids（takeEvents 已单点 trace 本批）。
   */
  protected applyEventBatch(events: AgentInputEvent[]): void {
    if (events.length === 0) return;
    try {
      this.applyEvents(events);
    } catch (cause) {
      throw new EventBatchApplyError(
        events.map((e) => e.id),
        cause
      );
    }
  }

  /**
   * 系统事件 factory：不引入第二套事件形状（AgentInputSource 不加 'timer'），
   * id/timestamp 交 normalize 补全。start 保证首次启动与后续恢复走同一条链路。
   */
  protected postSystemEvent(type: 'start'): void {
    this.post({ source: 'system', content: { type } });
  }

  // === Mailbox 消费 ===

  /**
   * 唯一的 Mailbox 消费入口：drain + 单点 batch trace。
   * 冲程开头/AI 边界的吸收与 interrupt/destroy 的丢弃共用此原子对，零例外；禁止裸调 mailbox.drain()。
   */
  protected takeEvents(): AgentInputEvent[] {
    const events = this.mailbox.drain();
    if (events.length > 0) {
      try {
        this.emitStateChange();
      } catch {
        // 状态推送失败不得阻断消费原子对（中断/销毁的同步前缀依赖它）
      }
    }
    return events;
  }

  getIdlePermits(): IdlePermit[] {
    return deriveIdlePermits(
      this.context.getAllMessages(),
      this.backgroundRegistry?.activeTaskIds() ?? [],
      (callId) => this.context.isToolCallSuccessful(callId)
    );
  }

  promoteToolToBackground(callId: string): boolean {
    return this.backgroundRegistry?.promote(callId) ?? false;
  }

  // === trace（best-effort 同步无抛，日志故障不得阻断 abort/门闩/资源释放） ===

  protected traceDiscarded(
    _events: AgentInputEvent[],
    _reason: 'user_interrupted' | 'destroyed'
  ): void {}

  protected traceRejectedEvent(input: AgentInputRequest, reason: string): void {
    try {
      appLog.warn({
        event: 'agent.input.accept.rejected',
        message: 'Agent input rejected',
        context: {
          scope: 'agent.input',
          agentId: this.id,
          reason,
          source: input.source,
          eventId: input.id,
        },
      });
    } catch {
      // best-effort
    }
  }

  // === 抽象方法 ===

  abstract buildSystemPrompt(): string;
  abstract getControlState(): AgentControlState;

  /**
   * 应用一批事件到上下文（AgentRuntime 实现模块分发）。
   * 只由 applyEventBatch 调用（错误包装收口）；实现不得自行 drain Mailbox。
   */
  protected abstract applyEvents(events: AgentInputEvent[]): void;

  /** 冲程 turn 配置（AgentRuntime 从 role.configureLoop 获取；每冲程 lazy 求值） */
  protected getTurnConfig(): TurnConfig {
    return {};
  }

  // === 工具 ===

  getAvailableTools(): Tool[] {
    return this.captureCatalogSnapshot().definitions(this.loadedDeferredTools) as Tool[];
  }

  /**
   * Async boundary preparation. AgentRuntime uses this to consume the one-time MCP startup
   * grace and admit newly available catalogs; the base engine has no external capability work.
   */
  protected async advanceModelBoundary(_signal: AbortSignal): Promise<void> {}

  /** Current catalog projection. Subclasses may add per-agent entries without mutating ToolFace. */
  protected captureCatalogSnapshot(): CatalogSnapshot {
    return this.toolCatalog.snapshot(this.toolFace);
  }

  /** Monotonic projection revision for diagnostics and protocol-pairing tests. */
  protected getModelBoundaryRevision(): number {
    return 0;
  }

  /**
   * Prompt, catalog and tool definitions are captured synchronously after boundary advancement.
   * Promise callbacks cannot interleave this block, so all three observe the same projection.
   */
  protected captureModelBoundarySnapshot(): ModelBoundarySnapshot {
    const systemPrompt = this.buildSystemPrompt();
    const catalog = this.captureCatalogSnapshot();
    const loadedDeferredTools: ReadonlySet<string> = new Set(this.loadedDeferredTools);
    const tools = Object.freeze(catalog.definitions(loadedDeferredTools)) as readonly Tool[];
    return Object.freeze({
      revision: this.getModelBoundaryRevision(),
      systemPrompt,
      catalog,
      tools,
      loadedDeferredTools,
    });
  }

  // === 内容事件（子类覆写并交给创建 Runtime 时注入的 observer） ===

  protected emitContentEvent(_event: AgentContentEvent): void {
    // Default no-op. Overridden by AgentRuntime.
  }

  protected emitLiveContent(_event: AgentLiveContentDelta): void {
    // Default no-op. Overridden by AgentRuntime.
  }

  // === 对话存储（子类覆写以写入 conversationStore） ===

  protected appendConversationEntry(
    _entry: ConversationWriteEntry,
    _metadata?: ConversationAppendMetadata
  ): void {
    // Default no-op. Overridden by AgentRuntime which calls conversationStore.append().
  }

  protected getActivityState(): AgentActivityState {
    return this.activityTracker.snapshot();
  }

  protected recordToolExecutionStarted(callId: string, startedAt: number): void {
    this.activityTracker.toolStarted(callId, startedAt);
    if (this.phase === 'waiting') this.phase = 'executing';
    this.emitStateChange();
  }

  protected recordToolExecutionFinished(callId: string, interval: ToolExecutionInterval): void {
    this.activityTracker.toolFinished(callId, interval);
    this.emitStateChange();
  }

  protected recordToolSettled(callId: string): void {
    this.activityTracker.toolSettled(callId);
  }

  // === 状态推送 ===

  emitStateChange(): void {
    // 世代唯一性：拆除中的 runtime 不发布状态——
    // 旧世代的迟到回调在源头哑掉，消费点无需实例比对
    if (this.destroyPromise) return;
    this.stateChangeCallback?.(this.getControlState());
  }

  /** 所有压缩入口共用同一套 UI 活动态，避免调用方各自补状态。 */
  private setCompactionActivity(active: boolean): void {
    if (active) {
      if (this.publishingCompactionActivity) return;
      this.publishingCompactionActivity = true;

      const now = Date.now();
      const activeRequest =
        this.aiRequestState?.phase !== 'finished' ? this.aiRequestState : undefined;
      this.requestStateBeforeCompaction = activeRequest;
      this.aiRequestState = {
        ...(activeRequest ?? {
          requestId: `compaction-${now}`,
          attempt: 0,
          maxAttempts: 0,
          logicalStartedAt: now,
          attemptStartedAt: now,
        }),
        phase: 'compacting',
        retryAt: undefined,
        outcome: undefined,
        errorCode: undefined,
        errorMessage: undefined,
      };
      this.emitStateChange();
      return;
    }

    if (!this.publishingCompactionActivity) return;
    this.publishingCompactionActivity = false;
    this.aiRequestState = this.requestStateBeforeCompaction;
    this.requestStateBeforeCompaction = undefined;
    this.emitStateChange();
  }

  // === Incident target ===

  getIncidentTarget(): AgentTarget {
    return this.incidentTarget;
  }

  protected recoverActiveErrors(): void {
    agentIncidentStore.recover(this.getIncidentTarget());
  }

  /** 枚举需要跟随当前 Agent 级联中断的子 Agent。 */
  listChildAgents(): AgentEngine[] {
    return [];
  }

  /** 中断后首次接收新输入时，根据当前运行时事实构造前置事件。 */
  protected buildInterruptionResumeEvents(): AgentInputRequest[] {
    return [];
  }

  // === 中断 ===

  /** 中断后钩子（子类 override 做额外处理，如写 header.json） */
  protected onAfterInterrupt(): void {
    this.emitStateChange();
  }

  /**
   * 中断 = 同步丢弃旧输入 + 请求取消；中断状态不粘滞到后续输入。
   * await 返回 = 调用时捕获的旧冲程已 settle（按 activation 承诺的如实回执，非全局无 Pump）。
   * 中断后任何新事件都可正常唤醒——"恢复"不是特殊状态迁移，就是一次普通的 post。
   */
  async interrupt(): Promise<void> {
    const activePump = this.pumpPromise;
    this._interrupted = true;

    // stopping 只用于在途冲程；纯 waiting 会话没有 finally 可以将其拨回 waiting。
    if (activePump) {
      this.phase = 'stopping';
      this.activityTracker.activityStopped();
    }

    // 中断前已排队的旧输入随 activation 作废：源头显式丢弃并留痕，
    // 此后"Mailbox 非空"恒等于"有待处理的新事实"，finally 复检无需分级
    this.traceDiscarded(this.takeEvents(), 'user_interrupted');
    // 取消在途工作（模块 onInterrupt：sync waiter、排队任务）——interrupt 与 destroy
    // 同步前缀共用同一步骤，唯一实现在此，子类不覆写 interrupt
    this.cancelInFlightWork();

    this.pumpController?.abort(new UserInterruptError());

    try {
      this.emitStateChange();
    } catch {
      // 状态广播不得阻断中断。
    }

    try {
      this.context.flush();
    } catch (error) {
      appLog.warn({
        event: 'agent.interrupt.cleanup.degraded',
        message: 'Agent interrupt cleanup degraded',
        context: { scope: 'agent.interrupt', agentId: this.id, stage: 'flush_context' },
        error,
      });
    }

    let children: AgentEngine[] = [];
    try {
      children = this.listChildAgents();
    } catch (error) {
      appLog.warn({
        event: 'agent.interrupt.cleanup.degraded',
        message: 'Agent interrupt cleanup degraded',
        context: { scope: 'agent.interrupt', agentId: this.id, stage: 'enumerate_children' },
        error,
      });
    }
    await Promise.all(
      children.map((child) =>
        child.instantInterrupt().catch((error) => {
          // 生命周期控制面诊断不得进入 Mailbox，否则会唤醒刚被中断的父代理。
          appLog.warn({
            event: 'agent.interrupt.cleanup.degraded',
            message: 'Agent interrupt cleanup degraded',
            context: {
              scope: 'agent.interrupt',
              agentId: this.id,
              childAgentId: child.id,
              stage: 'interrupt_child',
            },
            error,
          });
        })
      )
    );

    // 旧冲程 settle：在途工作全部退场后才返回（pumpPromise 出口全被 catch，从不 reject；保险防御）
    await activePump?.catch(() => {});

    // join 后结算 pending ask（唯一新增结算步）。
    // 不变量：interrupt() 返回前，若最新尾部仍有未结算的合法 ask_user，必须经
    // Settler 完成 interrupted 结算；结算不启动 AI；结算/广播失败降级 warn。
    try {
      this.settlePendingAsksOnInterrupt();
    } catch (error) {
      appLog.warn({
        event: 'agent.interrupt.cleanup.degraded',
        message: 'Agent interrupt cleanup degraded',
        context: { scope: 'agent.interrupt', agentId: this.id, stage: 'settle_pending' },
        error,
      });
    }

    // onAfterInterrupt 移位复用为最终广播：header 的 lastActiveAt 在一切退场后写，
    // 派生 pendingQuestion 已消失的最终状态由此发布——零新增广播调用
    try {
      this.onAfterInterrupt();
    } catch (error) {
      appLog.warn({
        event: 'agent.interrupt.cleanup.degraded',
        message: 'Agent interrupt cleanup degraded',
        context: { scope: 'agent.interrupt', agentId: this.id, stage: 'publish_final_state' },
        error,
      });
    }
  }

  /**
   * ESC 结算：只结算最新开放批次中未结算的合法 ask_user
   * （user_interrupted / not_started——suspended 稳态即"确未执行"的直接证据）。
   * 循环写批内每个是损坏/崩溃窗口防御，合法轨迹恒至多一个。
   * 普通工具不在此补结果：四条既有路径已在 join 前写完，异常残留由
   * 模型边界守卫下次按分类表兜底——interrupt 不做恢复修复。
   */
  protected settlePendingAsksOnInterrupt(): boolean {
    const messages = this.context.getAllMessages();
    let changed = false;

    // 带续跑的工具挂起：对服务器回 cancel（在途请求退场），tool_use 结算为
    // interrupted / unknown——原请求已在服务器侧启动，副作用状态不可知
    const pendingContinuation = this.pendingToolContinuation;
    if (pendingContinuation) {
      this.pendingToolContinuation = undefined;
      try {
        pendingContinuation.continuation.cancel();
      } catch {
        // cancel 是尽力而为的通知，失败不阻塞中断结算
      }
      changed =
        this.settler.settleLive({
          kind: 'system',
          callId: pendingContinuation.toolUseId,
          toolName: pendingContinuation.toolName,
          text: buildToolInterruptionResult({
            reason: 'user_interrupted',
            execution: 'unknown',
          }),
          ok: false,
        }) === 'inserted' || changed;
    }

    const batch = inspectLatestToolBatch(messages);
    if (!batch) return changed;
    for (const call of getUnsettledValidAskCalls(messages, batch)) {
      changed =
        this.settler.settleLive({
          kind: 'system',
          callId: call.id,
          toolName: call.name,
          text: buildToolInterruptionResult({
            reason: 'user_interrupted',
            execution: 'not_started',
          }),
          ok: false,
        }) === 'inserted' || changed;
    }
    return changed;
  }

  async instantInterrupt(): Promise<void> {
    // 在途 AI 请求的取消唯一来自冲程 signal（interrupt 内 pumpController.abort，
    // 经 callAI 的 options.signal 链入 Inference 应用端口——取消路径唯一化）
    this.cancelPendingApprovals('操作已被用户中断');
    await this.interrupt();
  }

  /**
   * 取消全部挂起审批（中断/销毁共用）。
   * 审批门接入冲程取消域后，这是 AbortSignal 的手动等价物。
   */
  protected cancelPendingApprovals(feedback: string): void {
    if (this.pendingApprovals.size > 0) {
      for (const [callId, { resolve }] of this.pendingApprovals) {
        resolve({ callId, decision: 'deny', feedback });
      }
      this.pendingApprovals.clear();
    }
  }

  // === 销毁（destroy 原语定稿） ===

  /**
   * 销毁：应用关闭 / 子代理回收 / 销毁式停止 三个调用方共用。
   * 与 interrupt 的分界只有一条：interrupt 保留上下文与资源在内存、任何新事件原地唤醒；
   * destroy 释放一切，"继续"只能从盘重建。
   *
   * destroy 成功的定义 = Pump 已退场
   * + owned boundaries 已终止 + 资源已释放。
   *
   * 两段式：
   * - 同步关门：门闩先装（即关门事实）→ 丢弃留痕 → 取消在途
   *   → onDestroyBegin 当场 allSettled → pump abort——全部完成于任何 await 之前；
   * - 异步 settle（finishDestroy）：activation join → 凭据收集 → errors 为空才释放资源。
   * 幂等：并发调用返回同一 Promise，rejected settlement 可被反复消费（由
   * 递归对称的结构支撑）。只允许从冲程外部调用（冲程内自毁等待自身 = 死锁）。
   */
  destroy(): Promise<void> {
    // ① 幂等门闩必须先于任何可能执行用户代码的操作安装：
    // abort() 会同步执行 listeners，若 listener 重入 destroy()，必须命中此短路
    if (this.destroyPromise) return this.destroyPromise;

    const deferred = createDeferred<void>();
    this.destroyPromise = deferred.promise;

    // ② 门闩即关门事实：post/ensurePump/emitStateChange 从此拒收留痕
    const activePump = this.pumpPromise;
    this.traceDiscarded(this.takeEvents(), 'destroyed');

    // 取消在途工作：冲程 signal 已全面接线（AI 请求/backoff/审批门均随 abort 退场，
    // 取消路径唯一化），手动等价物只剩挂起审批（覆盖无冲程期间）与模块 waiter
    this.cancelPendingApprovals('任务已停止');
    this.cancelInFlightWork();

    // ③ 边界终止发起（onDestroyBegin）：当场 allSettled——快速 reject 不得成为
    // unhandled rejection；单模块 throw 不阻断其余
    const closeSettlement = Promise.allSettled(this.collectDestroyBeginTasks());

    this.pumpController?.abort(new DisposedError());

    void this.finishDestroy(activePump, closeSettlement).then(deferred.resolve, deferred.reject);
    return this.destroyPromise;
  }

  /**
   * 拆除第二段：activation join → 凭据收集 →
   * errors 为空才释放资源。核心不变量：边界终止没有凭据 → 对应资源所有权
   * 不得释放给其他 AgentRun（租约保留即隔离，lease 本身就是“资源被占用”的既有位置）。
   * rejection 语义收紧：destroy rejection 只表示 teardown 不变量未建立。
   */
  private async finishDestroy(
    activePump: Promise<void> | null,
    closeSettlement: Promise<PromiseSettledResult<unknown>[]>
  ): Promise<void> {
    const errors: unknown[] = [];
    const collectRejected = (results: PromiseSettledResult<unknown>[]) => {
      for (const r of results) {
        if (r.status === 'rejected') errors.push(r.reason);
      }
    };

    // activation join：旧冲程 settle，在途 provider 收尾/工具执行全部退场
    if (activePump) {
      await activePump.catch((e) => errors.push(e));
    }

    // 边界终止凭据：allSettled 永不 reject——rejected 必须显式收集
    collectRejected(await closeSettlement);

    // 模块剩余重清理（内存级；非关键错误模块内部降级，不进 rejection）
    collectRejected(await Promise.allSettled(this.collectDestroyTasks()));

    // ★ 释放租约也是状态变更，同样排在凭据之后：
    // errors 非空 = 边界终止无凭据 = 资源可能仍被占用 → 租约保留（不释放给其他 AgentRun）
    if (errors.length === 0) {
      try {
        await this.releaseResources();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `Agent ${this.id} destroy completed with cleanup errors`);
    }
  }

  /** interrupt/destroy 同步关门共用的在途工作取消扩展点（模块 sync waiter 等） */
  protected cancelInFlightWork(): void {
    // 默认无操作，AgentRuntime 覆写
  }

  /**
   * 边界终止任务（子类提供；destroy 同步前缀当场 allSettled 消费）。
   * 每个任务是一个模块 onDestroyBegin 的 closePromise；同步 throw 由子类转为 rejection。
   */
  protected collectDestroyBeginTasks(): Array<Promise<unknown>> {
    return [];
  }

  /** 模块级销毁任务（子类提供；allSettled 消费，单个失败不阻断其余） */
  protected collectDestroyTasks(): Array<Promise<unknown>> {
    return [];
  }

  /**
   * 资源租约释放（子类提供）——唯一写入点：
   * 仅 finishDestroy 在 errors 为空时调用，模块永不直接释放。
   */
  protected async releaseResources(): Promise<void> {
    // 默认无操作，AgentRuntime 覆写
  }

  // === 事件注入 ===

  /**
   * 注入外部事件 —— 事件唯一写入点，也是 envelope 归一化的强制入口。
   * 归一化是全函数（补全 id/timestamp，永不因内容拒绝）；唯一的不接受是 disposed。
   *
   * @returns 是否被接收。false = runtime 已拆除（留 trace），调用管道据此回报发送方；
   *          两层职责分明：trace 负责审计"为什么没接收"，返回值负责告诉发送者"投递失败"。
   */
  public post(input: AgentInputRequest): boolean {
    if (this.destroyPromise) {
      this.traceRejectedEvent(input, 'runtime_disposed');
      return false;
    }

    const event = normalizeAgentInputEvent(input);
    if (this._interrupted) {
      for (const resumeEvent of this.buildInterruptionResumeEvents()) {
        this.mailbox.push(normalizeAgentInputEvent(resumeEvent));
      }
    }
    this.mailbox.push(event); // 事实永远先落队列
    this._interrupted = false;
    try {
      this.emitStateChange();
    } catch {
      // 可观测性故障不得阻断投递（同旨）
    }

    // 调度只有一条路：ensurePump。冲程运行中事件留在队列，
    // 由 runTurn 的 AI 边界吸收或冲程结束的 finally 复检接手。
    this.ensurePump();
    return true;
  }

  // === 审批机制 ===

  async handleApprovalRequest(
    pending: PendingToolCall,
    signal?: AbortSignal
  ): Promise<ToolApprovalDecision> {
    if (this.approvalMode === 'auto' && pending.modeInvariant !== true) {
      return { callId: pending.id, decision: 'allow' };
    }

    // 审批门纳入冲程取消域：abort 即 deny 收尾，挂起 Promise 不得活过冲程
    if (signal?.aborted) {
      return { callId: pending.id, decision: 'deny', feedback: '操作已取消' };
    }

    return new Promise((resolve) => {
      // linkAbort 习语：fn throw 不逃逸事件分发、settle 后 dispose
      const disposeAbort = linkAbort(signal, () => {
        // 已被 respondToApproval / cancelPendingApprovals 处置则无事可做
        if (!this.pendingApprovals.has(pending.id)) return;
        const wasVisible = this.pendingApprovals.keys().next().value === pending.id;
        this.pendingApprovals.delete(pending.id);
        if (wasVisible) this.emitStateChange();
        resolve({ callId: pending.id, decision: 'deny', feedback: '操作已取消' });
      });

      const wasEmpty = this.pendingApprovals.size === 0;
      this.pendingApprovals.set(pending.id, {
        pending,
        resolve: (d) => {
          disposeAbort();
          resolve(d);
        },
      });

      if (wasEmpty) this.emitStateChange();
    });
  }

  public respondToApproval(decision: ToolApprovalDecision): boolean {
    const item = this.pendingApprovals.get(decision.callId);
    if (!item) {
      return false;
    }

    const canSwitchToAuto =
      decision.decision === 'allow' &&
      decision.changeToAuto === true &&
      item.pending.modeInvariant !== true;
    if (canSwitchToAuto) {
      this.approvalMode = 'auto';
      this.appendConversationEntry({
        t: 'marker',
        ts: Date.now(),
        key: 'approvalMode',
        value: 'auto',
      });
      appLog.info({
        event: 'agent.approval_mode.update.completed',
        message: 'Agent approval mode updated',
        context: { scope: 'agent.approval_mode', agentId: this.id, approvalMode: 'auto' },
      });
      // Auto 统一放行工具审批；计划正文等工作流确认继续等待。
      for (const [callId, pendingItem] of this.pendingApprovals) {
        if (callId !== decision.callId && pendingItem.pending.modeInvariant === true) continue;
        pendingItem.resolve({ callId, decision: 'allow' });
        this.pendingApprovals.delete(callId);
      }
      this.emitStateChange();
      return true;
    }

    if (decision.feedback && decision.decision === 'deny') {
      item.resolve(decision);
      this.pendingApprovals.delete(decision.callId);

      this.post({
        id: `feedback-${decision.callId}`,
        timestamp: new Date(),
        source: 'user',
        content: decision.feedback,
        priority: 'high',
        images: decision.images,
      });

      this.emitStateChange();
      return true;
    }

    item.resolve(decision);
    this.pendingApprovals.delete(decision.callId);
    this.emitStateChange();
    return true;
  }

  public setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.appendConversationEntry({
      t: 'marker',
      ts: Date.now(),
      key: 'approvalMode',
      value: mode,
    });

    if (mode === 'auto' && this.pendingApprovals.size > 0) {
      for (const [callId, item] of this.pendingApprovals) {
        if (item.pending.modeInvariant === true) continue;
        item.resolve({ callId, decision: 'allow' });
        this.pendingApprovals.delete(callId);
      }
    }

    this.emitStateChange();
  }

  // === AI 调用 ===

  /**
   * 上下文溢出恢复：provider 判定这份 payload 超窗 → 压缩历史 → 重发一次。
   *
   * 这条路径两家 provider 共用，不是 OpenAI 专属补丁——Anthropic 的 `count_tokens`
   * 文档声明为 estimate，二级准入把溢出变成极小概率，但没有把它变成零。
   *
   * **只重发一次**：第二次仍溢出说明压缩救不了它（单条新增自己就超过窗口，
   * 而压缩删的是历史），如实上抛 provider 的原错误，不进入循环。
   * 恢复必须发生在 AgentIncident 写入之前，否则会话里会留下一条已经恢复的 incident。
   */
  private async requestWithOverflowRecovery(
    systemPrompt: string,
    tools: Tool[],
    messages: Message[],
    options: AgentInferenceOptions,
    signal?: AbortSignal
  ): Promise<AIResponse> {
    const request = {
      systemPrompt,
      tools,
      model: this.currentTarget,
      reasoningOverride: this.reasoningOverride,
      promptCacheKey: this.id,
    };
    try {
      return await this.invokeWithVisibleContext(request, tools, messages, options);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (normalizeAIRequestFailure(error).errorType !== AIErrorType.CONTEXT_OVERFLOW) throw error;

      const compacted = await this.context.compactAfterOverflow(signal, (active) =>
        this.setCompactionActivity(active)
      );
      if (!compacted) throw error;
      signal?.throwIfAborted();
      if (this.aiRequestState) {
        this.aiRequestState = {
          ...this.aiRequestState,
          phase: 'resending',
          retryAt: undefined,
          errorCode: undefined,
          errorMessage: undefined,
        };
        this.emitStateChange();
      }
      return await this.invokeWithVisibleContext(request, tools, compacted, options);
    }
  }

  private async invokeWithVisibleContext(
    request: {
      systemPrompt: string;
      tools: Tool[];
      model: ModelTarget;
      reasoningOverride: ReasoningSelection;
      promptCacheKey: string;
    },
    tools: Tool[],
    messages: Message[],
    options: AgentInferenceOptions,
  ): Promise<AIResponse> {
    const active = Object.freeze({
      systemPrompt: request.systemPrompt,
      tools,
      messages,
      requestTokenCheckpoints: this.context.projectRequestTokenCheckpoints(messages),
    }) satisfies ActiveModelContext;
    this.activeModelContext = active;
    try {
      return await this.inference.invoke({ ...request, messages }, options);
    } finally {
      if (this.activeModelContext === active) this.activeModelContext = undefined;
    }
  }

  /**
   * 统一的 AI 调用方法
   * 自动处理：token 记录、重试回调、phase 切换、指标收集
   * signal = 冲程取消域：abort 即时取消在途请求与 retry backoff
   */
  protected async callAI(
    systemPrompt: string,
    tools: Tool[],
    messages: Message[],
    signal?: AbortSignal
  ): Promise<AIResponse> {
    const requestId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const requestBoundary = this.context.captureRequestBoundary();
    // 统一写入点：本轮全部输入消息与上轮工具结果落盘后才发起请求
    this.context.flush();

    // 逻辑请求开始；attempt 时间戳由 onAttemptStart 刷新
    const startTime = Date.now();
    this.activityTracker.aiStarted(startTime);
    const retryCallbackOptions: AgentInferenceOptions = {
      ...this.buildRetryCallbackOptions(signal),
      requestId,
      logicalStartedAt: startTime,
      onVisibleDelta: (delta: VisibleDelta) =>
        this.emitLiveContent({
          agentId: this.id,
          requestId,
          ...delta,
        }),
    };
    this.aiRequestState = {
      requestId,
      phase: 'requesting',
      attempt: 0,
      maxAttempts: 0,
      logicalStartedAt: startTime,
      attemptStartedAt: startTime,
    };
    this.phase = 'thinking';
    this.emitStateChange();

    let response: AIResponse;
    try {
      response = await this.requestWithOverflowRecovery(
        systemPrompt,
        tools,
        messages,
        { ...retryCallbackOptions, signal },
        signal
      );
      this.context.commitSuccessfulRequest(requestBoundary, response.requestInfo);
      this.activityTracker.aiCompleted(response.requestInfo, response.content);
      const usage = response.requestInfo.usage;
      const cacheReadTokens = usage.cacheReadTokens ?? 0;
      const cacheHitPercent =
        usage.inputTokens !== undefined &&
        usage.inputTokens > 0 &&
        cacheReadTokens <= usage.inputTokens
          ? Math.round((cacheReadTokens / usage.inputTokens) * 10_000) / 100
          : null;
      const cumulative = this.activityTracker.snapshot().runMetrics;
      appLog.debug({
        event: 'agent.inference.cache.measured',
        message: 'Inference cache usage measured',
        context: {
          scope: 'agent.inference.cache',
          agentId: this.id,
          requestId: response.requestInfo.requestId,
          model: response.requestInfo.model,
          inputTokens: usage.inputTokens ?? null,
          cacheReadTokens: usage.cacheReadTokens ?? null,
          cacheWriteTokens: usage.cacheWriteTokens ?? null,
          cacheHitPercent,
          cumulativeInputTokens: cumulative.inputTokens,
          cumulativeCacheReadTokens: cumulative.cacheReadTokens,
        },
      });
      this.aiRequestState = { ...this.aiRequestState, phase: 'finished', outcome: 'success' };
      this.recoverActiveErrors();
    } catch (error) {
      // 取消先行：取消真相源唯一 = 本冲程 signal，
      // 不做错误文本推断；取消不是错误，不写 AgentIncident，原错误直接上抛
      if (signal?.aborted) {
        this.activityTracker.aiStopped();
        this.aiRequestState = {
          ...this.aiRequestState,
          phase: 'finished',
          outcome: 'cancelled',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }

      // turn 链路 AI 错误的唯一 AgentIncident 写入点：
      // 违约 provider throw string/frozen Error 也经 normalize 规整
      const failure = normalizeAIRequestFailure(error);
      this.activityTracker.aiStopped();
      this.aiRequestState = {
        ...this.aiRequestState,
        phase: 'finished',
        outcome: 'failed',
        retryAt: undefined,
        errorCode: failure.errorType,
        errorMessage: failure.message,
      };

      agentIncidentStore.raise({
        severity: 'error',
        category: 'ai_request',
        source: this.getIncidentTarget(),
        message: failure.message,
        code: failure.errorType,
        originalError: failure.message,
        context: failure.diagnostics,
      });

      // 凭据只能在事实之后产生：写入成功后才创建，cause 保留原错误；
      // 消费方（handlePumpFailure）只认类型，不再依赖"同一实例"跨组件契约
      throw new RecordedAIRequestError(failure, error);
    } finally {
      this.emitStateChange();
    }

    return response;
  }

  // === Turn 循环（用普通返回表达控制流） ===

  /**
   * runTurn：AI/tool 回合循环，直到 yield（terminal/挂起/自然 idle）。
   * return 只表达业务 yield；取消一律以 AbortError 异常离开（throwIfAborted），
   * 由 ensurePump 的 catch 分类处置——若取消也走 return {}，用户 stop 会被误判成
   * 正常业务 yield，绕过 cancelled 出口。
   */
  protected async runTurn(signal: AbortSignal, config: TurnConfig = {}): Promise<TurnOutcome> {
    const resolveExecuteMode = (): ExecuteToolsOptions['mode'] => {
      const configuredMode = config.executeMode;
      return typeof configuredMode === 'function'
        ? configuredMode()
        : (configuredMode ?? 'sequential');
    };

    for (;;) {
      // abort 走异常出口，绝不伪装成自然 idle 的 return {}
      signal.throwIfAborted();

      // AI/tool 执行期间到达的新事件在每个 AI 边界统一吸收（唯一消费入口）
      this.applyEventBatch(this.takeEvents());

      // 已作答的工具续跑（MCP elicitation）在模型边界前消费：
      // 答案喂回在途请求 → 最终 tool_result 或下一轮挂起
      await this.resumeToolContinuation();

      // 唯一模型边界守卫：每次准备产生任何 AI 请求前执行——
      // 含 token 计算与 compaction（getMessagesForAI 是两者唯一入口，本守卫先于它）。
      // pending ask → 直接 yield，零 Provider 请求；异常缺失 → 尾部确定性修复后继续。
      const boundary = this.reconcileLatestToolBatch('runtime');
      if (boundary.wrote) {
        this.context.flush();
      }
      if (boundary.pendingAsk) {
        return {};
      }

      await this.advanceModelBoundary(signal);
      signal.throwIfAborted();
      const modelBoundary = this.captureModelBoundarySnapshot();
      const { systemPrompt, catalog: snapshot, tools } = modelBoundary;
      const toolList = tools as Tool[];
      const { messages } = await this.context.getMessagesForAI(
        {
          systemPrompt,
          tools: toolList,
          model: this.currentTarget,
          reasoningOverride: this.reasoningOverride,
          promptCacheKey: this.id,
        },
        signal,
        (active) => this.setCompactionActivity(active)
      );

      // getMessagesForAI 内部可能触发 compaction（耗时 AI 请求），期间可能被中断——中断后不再发起新请求
      signal.throwIfAborted();

      const response = await this.callAI(systemPrompt, toolList, messages, signal);
      const toolUses = response.content.filter((c: ContentBlock) => c.type === 'tool_use');

      if (response.content.length === 0) {
        throw new Error(
          'AI returned empty response (no content blocks); upstream stream likely truncated'
        );
      }

      for (const t of toolUses) {
        if (typeof t.input === 'string' && t.input.length > 0) {
          throw new Error(
            `tool_use input is unparsed string for ${t.name} (likely stream truncation, len=${t.input.length})`
          );
        }
        if (!t.input || typeof t.input !== 'object') {
          appLog.warn({
            event: 'agent.tool_input.normalize.degraded',
            message: 'Malformed tool input was normalized',
            context: {
              scope: 'agent.tool_input',
              agentId: this.id,
              toolName: t.name,
              toolUseId: t.id,
              inputType: typeof t.input,
            },
          });
          (t as { input?: unknown }).input = {};
        }
      }

      // The model response happened before every branch below. Persist it synchronously before
      // any tool execution or settlement so the JSONL records the same causal order.
      this.context.addAssistantMessage(
        response.content as ContentBlock[],
        response.requestInfo
      );
      this.publishAssistantText(response.content);

      // abort 与流式完成存在竞态：中断后即使拿到完整响应也只落盘，不执行工具——
      // 整批一律不执行是 not_started 的直接证据（三条已知路径之一）
      if (signal.aborted) {
        for (const t of toolUses) {
          if (!t.id) continue;
          this.settler.settleLive({
            kind: 'system',
            callId: t.id,
            toolName: t.name ?? 'unknown',
            text: buildToolInterruptionResult({
              reason: 'user_interrupted',
              execution: 'not_started',
            }),
            ok: false,
          });
        }
        signal.throwIfAborted(); // 进入分支即 aborted：落盘完成后随取消域退场（必抛）
        return {}; // 不可达，仅为控制流完整
      }

      if (toolUses.length === 0) {
        return {}; // 自然 idle
      }

      // send_event/ask_user 混批守门：独占工具必须是
      // 该响应中唯一的 tool call，混批一律整批打回不执行（普通确定性失败文案——
      // 错误即文档，打回发生在 executeTools 之前，普通工具零副作用），本轮继续让 AI 重试
      const gateViolation = this.checkExclusiveToolGate(toolUses);
      if (gateViolation) {
        for (const t of toolUses) {
          if (!t.id) continue;
          this.settler.settleLive({
            kind: 'system',
            callId: t.id,
            toolName: t.name ?? 'unknown',
            text: gateViolation,
            ok: false,
          });
        }
        continue;
      }

      config.onBeforeExecuteTools?.(toolUses);

      this.phase = 'executing';
      this.emitStateChange();

      const toolUseIds = new Set(toolUses.map((t) => t.id!).filter(Boolean));

      try {
        const outcome = await this.executeTools(
          toolUses,
          snapshot,
          {
            mode: resolveExecuteMode(),
            signal,
            onAfterExecute: (toolUse, execResult) => {
              toolUseIds.delete(toolUse.id!);
              config.onAfterExecute?.(toolUse, execResult);
            },
            onSuspended: (toolUse) => {
              // orphan 集合清理对 suspended 照常执行（A 移出集合，
              // abort/关闭的孤儿补写碰不到它）；role.onAfterExecute 不调用
              toolUseIds.delete(toolUse.id!);
            },
          },
          modelBoundary.loadedDeferredTools
        );
        this.context.flush();

        if (outcome.terminalReason) {
          return { terminalReason: outcome.terminalReason };
        }
        if (outcome.suspended) return {};
        // need_user_action 不是 Assignment 终态；成功结算后由对话事实派生
        // user_action permit，在这里结束当前冲程，等待父流程转达用户已完成操作。
        if (this.getIdlePermits().some((permit) => permit.kind === 'user_action')) return {};
        // 普通工具结果已写入上下文，继续调用 AI 获取下一步
      } catch (error) {
        if (toolUseIds.size > 0) {
          appLog.warn({
            event: 'agent.tool_batch.settle.degraded',
            message: 'Interrupted tool batch required fallback settlement',
            context: {
              scope: 'agent.tool_batch',
              agentId: this.id,
              unsettledToolCount: toolUseIds.size,
              toolUseIds: [...toolUseIds],
            },
          });
          for (const id of toolUseIds) {
            // 已进入执行管线的 call 无法证明未执行 → execution: unknown
            const call = toolUses.find((toolUse) => toolUse.id === id);
            this.settler.settleLive({
              kind: 'system',
              callId: id,
              toolName: call?.name ?? 'unknown',
              text: buildToolInterruptionResult({
                reason: 'user_interrupted',
                execution: 'unknown',
              }),
              ok: false,
            });
          }
        }
        this.context.flush();
        throw error;
      }
    }
  }

  /**
   * 独占工具守门：send_event、ask_user
   * 必须单独调用。返回非 null = 违规，值为写给每个 tool_use 的普通确定性失败文本
   * （不定义本地协议错误结构）。
   */
  protected checkExclusiveToolGate(toolUses: ContentBlock[]): string | null {
    if (toolUses.length <= 1) return null;

    const isExclusiveCall = (t: ContentBlock): boolean => {
      if (t.name === 'ask_user') return true;
      if (t.name === 'send_event') return true;
      return false;
    };

    const exclusiveCalls = toolUses.filter(isExclusiveCall);
    if (exclusiveCalls.length === 0) return null;

    // ask_user 违规固定文案：教 AI 合并到一次调用的 questions 数组
    if (exclusiveCalls.some((t) => t.name === 'ask_user')) {
      return ASK_USER_GATE_VIOLATION_TEXT;
    }

    return (
      `${[...new Set(exclusiveCalls.map((t) => t.name))].join('、')} 是独占工具，` +
      `必须作为该轮响应中唯一的工具调用，不得与任何其他工具混批。` +
      `本批 ${toolUses.length} 个工具调用全部未执行。请先单独完成其他操作，最后单独调用该工具。`
    );
  }

  /**
   * 消费已作答的工具续跑（MCP elicitation/MRTR）：把答案喂回在途请求，
   * 产出最终 tool_result（与普通工具同一 settle 渲染），或服务器再度追问
   * 时滚动为下一轮挂起。中断竞态由 settleLive 的唯一插入语义兜底
   * （interrupt 路径先写为 interrupted 时这里得 already_settled，不双写）。
   */
  protected async resumeToolContinuation(): Promise<void> {
    const pending = this.pendingToolContinuation;
    if (!pending?.answers) return;

    this.pendingToolContinuation = undefined;
    let outcome: ToolOutput<unknown> | ToolSuspension;
    const startedAt = Date.now();
    this.recordToolExecutionStarted(pending.toolUseId, startedAt);
    try {
      outcome = await pending.continuation.resume(pending.answers);
    } catch (error) {
      const signal = this.pumpController?.signal;
      if (isMcpAbortError(error, signal)) throw signal?.reason ?? error;
      outcome = {
        ok: false,
        text: `MCP 工具续跑失败：${sanitizeMcpErrorText(error, { maxLength: 4_096 })}`,
      };
    } finally {
      this.recordToolExecutionFinished(pending.toolUseId, {
        startedAt,
        finishedAt: Date.now(),
      });
    }

    if (isToolSuspension(outcome)) {
      if (outcome.continuation) {
        this.pendingToolContinuation = {
          toolUseId: pending.toolUseId,
          toolName: pending.toolName,
          continuation: outcome.continuation,
        };
        this.emitStateChange();
        return;
      }
      // 无续跑通道的再挂起在这条链上不成立：写失败结果防悬挂
      outcome = { ok: false, text: 'MCP 工具再次挂起但未携带续跑通道' };
    }

    this.settler.settleLive({
      kind: 'tool',
      callId: pending.toolUseId,
      toolName: pending.toolName,
      result: toToolResult(outcome),
      artifacts: outcome.artifacts,
    });
    this.context.flush();
    this.emitStateChange();
  }

  /**
   * 唯一模型边界守卫 / 尾部确定性修复（与恢复修复同一函数、同一分类）：
   * | 最新批次                      | 处理                                     |
   * | 单个合法 ask_user             | 保持 pending（pendingAsk=true）          |
   * | 单个非法 ask_user             | 验证失败文本（parseAskUserInput 错误）   |
   * | 批次含 ask_user 且 call 数>1  | 全部缺失 call 写 gate 违规失败文本       |
   * | 纯普通工具批次缺结果          | 全部缺失 call 写 interrupted / unknown   |
   * | 重复 call ID / 无法唯一定位   | 不写，继续构建请求，交给 Anthropic|
   * 只检查最新 assistant 批次，不向前扫描历史（原则 4）。
   */
  protected reconcileLatestToolBatch(origin: 'runtime' | 'recovery'): {
    pendingAsk: boolean;
    wrote: boolean;
  } {
    const messages = this.context.getAllMessages();
    const batch = inspectLatestToolBatch(messages);
    if (!batch) return { pendingAsk: false, wrote: false };
    const missing = batch.calls.filter((c) => !c.settled);
    if (missing.length === 0) return { pendingAsk: false, wrote: false };

    let wrote = false;
    const settle = (id: string, result: string) => {
      const call = batch.calls.find((candidate) => candidate.id === id);
      if (
        this.settler.settleLive({
          kind: 'system',
          callId: id,
          toolName: call?.name ?? 'unknown',
          text: result,
          ok: false,
        }) === 'inserted'
      )
        wrote = true;
    };

    // 带续跑的工具挂起（MCP elicitation）：唯一缺失 call 且续跑在册 → 保持 pending。
    // recovery 时续跑内存已失（在途请求作废），自然落到下方 interrupted 分类。
    if (
      this.pendingToolContinuation &&
      missing.length === 1 &&
      missing[0].id === this.pendingToolContinuation.toolUseId &&
      resolveToolUseSettlement(messages, missing[0].id) === 'insertable'
    ) {
      return { pendingAsk: true, wrote: false };
    }

    const hasAsk = batch.calls.some((c) => c.name === 'ask_user');
    if (hasAsk && batch.calls.length === 1) {
      const call = batch.calls[0];
      const parsed = parseAskUserInput(call.input);
      if (parsed.ok) {
        // 合法 pending 判据含"可唯一结算"：不满足即表面 pending——
        // 不写、不阻塞，守卫按"无法唯一定位"行照常构建请求
        const pendingAsk = getValidPendingAskUser(messages) !== undefined;
        return { pendingAsk, wrote };
      }
      settle(call.id, parsed.error);
      return { pendingAsk: false, wrote };
    }
    if (hasAsk) {
      for (const c of missing) settle(c.id, ASK_USER_GATE_VIOLATION_TEXT);
      return { pendingAsk: false, wrote };
    }

    for (const c of missing) {
      settle(
        c.id,
        buildToolInterruptionResult({
          reason: origin === 'recovery' ? 'recovery_interrupted' : 'runtime_interrupted',
          execution: 'unknown',
        })
      );
    }
    return { pendingAsk: false, wrote };
  }

  // === 工具执行 ===

  /**
   * 统一的工具执行管线
   * 核心保证：每个 tool_use 都会有对应的 tool_result
   */
  protected async executeTools(
    toolUses: ContentBlock[],
    snapshot: CatalogSnapshot,
    options: ExecuteToolsOptions,
    loadedDeferredTools: ReadonlySet<string>
  ): Promise<{ terminalReason?: TerminalReason; suspended: boolean }> {
    const validToolUses = toolUses.filter((t) => t.name && t.id);
    let terminalReason: TerminalReason | undefined;
    let suspended = false;

    const settleSystem = (toolUse: ContentBlock, text: string, ok: boolean): ToolResult => {
      const result: ToolResult = { ok, text };
      this.settler.settleLive({
        kind: 'system',
        callId: toolUse.id!,
        toolName: toolUse.name!,
        text,
        ok,
      });
      return result;
    };

    const executeOne = async (toolUse: ContentBlock) => {
      const action = options.onBeforeExecute?.(toolUse) ?? 'execute';
      if (action === 'skip') return { kind: 'skip' as const, toolUse };
      if (action === 'placeholder') {
        return {
          kind: 'placeholder' as const,
          toolUse,
          text: JSON.stringify({ status: 'dispatched', message: '工具调用已分发执行' }),
        };
      }
      return {
        kind: 'outcome' as const,
        toolUse,
        outcome: await this.toolCoordinator.run(
          {
            modelName: toolUse.name!,
            rawParams: toolUse.input ?? {},
            callId: toolUse.id!,
          },
          snapshot,
          loadedDeferredTools
        ),
      };
    };

    const commitOne = (item: Awaited<ReturnType<typeof executeOne>>): void => {
      if (item.kind === 'skip') return;
      if (item.kind === 'placeholder') {
        const result = settleSystem(item.toolUse, item.text, true);
        options.onAfterExecute?.(item.toolUse, result);
        return;
      }
      if (isToolSuspension(item.outcome)) {
        suspended = true;
        if (item.outcome.continuation && item.toolUse.id) {
          this.pendingToolContinuation = {
            toolUseId: item.toolUse.id,
            toolName: item.toolUse.name ?? 'unknown',
            continuation: item.outcome.continuation,
          };
        }
        options.onSuspended?.(item.toolUse);
        return;
      }

      if (options.signal?.aborted && !item.outcome.result.ok) {
        const text = buildToolInterruptionResult({
          reason: 'user_interrupted',
          execution: 'unknown',
        });
        const result = settleSystem(item.toolUse, text, false);
        options.onAfterExecute?.(item.toolUse, result);
        return;
      }

      const committed = item.outcome.commit(this.settler);
      terminalReason ??= committed.terminal;
      options.onAfterExecute?.(item.toolUse, item.outcome.result);
    };

    // options.mode 是本批快照；实时 confirm 是并行分支的最终安全门。
    const executeInParallel =
      options.mode === 'parallel' && this.approvalMode === 'auto' && validToolUses.length > 1;

    if (executeInParallel) {
      for (const item of await Promise.all(validToolUses.map(executeOne))) commitOne(item);
    } else {
      for (const toolUse of validToolUses) {
        // 中断后不再启动新工具，为剩余 tool_use 写占位结果保持对话完整——
        // "尚未启动"是 not_started 的直接证据（三条已知路径之一）
        if (options.signal?.aborted) {
          const text = buildToolInterruptionResult({
            reason: 'user_interrupted',
            execution: 'not_started',
          });
          const result = settleSystem(toolUse, text, false);
          options.onAfterExecute?.(toolUse, result);
          continue;
        }
        commitOne(await executeOne(toolUse));
      }
    }

    return { terminalReason, suspended };
  }

  // === 重试过程事件 ===

  /**
   * 重试过程事件回调：维护权威 AIRequestState。
   * 纯过程事件（attempt_started / backoff_started）——终局（finished）唯一由
   * callAI 的 return/throw/aborted 更新，终局双写（onRetrySuccess/onRetryExhausted）
   * 已删除；AgentIncident 唯一写入点在 callAI 的 catch。
   * 守卫只认本冲程 signal：冲程取消后迟到回调不再更新/发布状态。
   */
  protected buildRetryCallbackOptions(
    signal?: AbortSignal
  ): Omit<AgentInferenceOptions, 'requestId' | 'logicalStartedAt'> {
    return {
      onAttemptStart: (info: { attempt: number; maxAttempts: number }) => {
        if (signal?.aborted || !this.aiRequestState) return;
        this.aiRequestState = {
          ...this.aiRequestState,
          phase: this.aiRequestState.phase === 'resending' ? 'resending' : 'requesting',
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          attemptStartedAt: Date.now(),
          retryAt: undefined,
        };
        this.emitStateChange();
      },

      onBackoff: (info: AgentInferenceBackoff) => {
        if (signal?.aborted || !this.aiRequestState) return;

        this.aiRequestState = {
          ...this.aiRequestState,
          phase: 'backoff',
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          // retryAt 是 Runner 给的绝对时间：UI 直接倒计时，不自己推算
          retryAt: info.retryAt,
          errorCode: info.errorType,
          errorMessage: info.errorMessage,
        };
        // attempt trace 只进日志，不新增活跃 AgentIncident

        this.emitStateChange();
      },
    };
  }

  // === 完整 assistant 正文通知 ===

  protected publishAssistantText(content: ContentBlock[]): void {
    const segments: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) segments.push(block.text);
    }
    const textContent = segments.join('\n');

    if (textContent.startsWith('Decisions:') || textContent.startsWith('[INTERNAL_DECISION_LOG]')) {
      appLog.warn({
        event: 'agent.output.publish.rejected',
        message: 'Internal decision output was suppressed',
        context: {
          scope: 'agent.output',
          agentId: this.id,
          reason: 'internal_decision_prefix',
        },
      });
      return;
    }

    if (textContent) {
      this.emitContentEvent({ type: 'assistant_text', content: textContent });
    }
  }

  // === 模型管理 ===

  public setModel(model: string, persist = true): void {
    const target = parseModelTargetReference(model);
    this.inference.assertTarget(target);
    this.currentTarget = target;
    this.currentModel = formatModelTarget(target);
    this.context.setTarget(target);
    const rememberedReasoning = this.reasoningByModel.get(this.currentModel);
    const nextReasoning = rememberedReasoning ?? this.inference.resolveReasoning(target).selection;
    this.reasoningOverride = nextReasoning;
    this.reasoningByModel.set(this.currentModel, nextReasoning);
    if (persist) {
      this.appendConversationEntry({
        t: 'marker',
        ts: Date.now(),
        key: 'model',
        value: this.currentModel,
      });
      this.appendConversationEntry({
        t: 'marker',
        ts: Date.now(),
        key: 'reasoningOverride',
        value: nextReasoning,
      });
    }
    appLog.info({
      event: 'agent.model.update.completed',
      message: 'Agent model updated',
      context: { scope: 'agent.model', agentId: this.id, model: this.currentModel },
    });
    this.emitStateChange();
  }

  public setReasoningOverride(selection?: ReasoningSelection, persist = true): void {
    const nextReasoning =
      selection ?? this.inference.resolveReasoning(this.currentTarget).selection;
    this.reasoningOverride = nextReasoning;
    this.reasoningByModel.set(this.currentModel, nextReasoning);
    if (persist) {
      this.appendConversationEntry({
        t: 'marker',
        ts: Date.now(),
        key: 'reasoningOverride',
        value: nextReasoning,
      });
    }
    this.emitStateChange();
  }

  public getModel(): string {
    return this.currentModel;
  }

  public getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  // === Token 统计 ===

  /** 广播用的用量。全部数字来自 provider，本地不做任何求和。 */
  public getContextUsage(): ContextUsage {
    return this.context.getContextUsage();
  }

  /** 上下文明细。冷路径，只在 UI 打开明细面板时按需构建。 */
  public buildContextSnapshot(): ContextSnapshot {
    const active = this.activeModelContext;
    if (active) return { ...active, usage: this.context.getContextUsage() };

    const boundary = this.captureModelBoundarySnapshot();
    return this.context.buildContextSnapshot(boundary.systemPrompt, boundary.tools);
  }

  // === 工具链初始化 ===

  protected initToolExecution(
    catalog: ToolCatalog,
    face: FinalToolFace,
    activation: ToolActivationContext
  ): void {
    this.toolCatalog = catalog;
    this.toolFace = face;
    this.backgroundRegistry = new BackgroundRegistry({
      onWarning: (_message, error) =>
        appLog.warn({
          event: 'agent.background_task.cleanup.degraded',
          message: 'Background task cleanup degraded',
          context: { scope: 'agent.background_task', agentId: this.id },
          error,
        }),
      onChange: () => this.emitStateChange(),
    });
    const contexts = new ToolCallContextFactory({
      activation,
      signal: () => {
        if (!this.pumpController) throw new Error('Tool execution requires an active pump');
        return this.pumpController.signal;
      },
      background: this.backgroundRegistry,
      deferredTools: (snapshot) =>
        createDeferredToolsPort(() => snapshot, this.loadedDeferredTools),
    });
    const observer: ToolObserver = {
      start: (raw) => {
        this.emitContentEvent({
          type: 'tool_start',
          toolCallId: raw.callId,
          toolName: raw.modelName,
          params: raw.rawParams as Record<string, unknown>,
        });
      },
      executionStarted: (raw, startedAt) => {
        this.recordToolExecutionStarted(raw.callId, startedAt);
      },
      executionFinished: (raw, interval) => {
        this.recordToolExecutionFinished(raw.callId, interval);
      },
      finish: (observation) => {
        if (observation.outcome === 'suspended') return;
        const ok = observation.outcome === 'ok';
        const toolName = observation.effectiveName ?? observation.raw.modelName;
        this.emitContentEvent({
          type: 'tool_finish',
          ok,
          toolCallId: observation.raw.callId,
          toolName,
          result: observation.result?.text,
        });
      },
    };
    this.toolCoordinator = new ToolCoordinator({
      contexts,
      observer,
      ...(this.pilotPorts
        ? { skills: { classify: (skill: string) => this.pilotPorts!.skills.classifySkill(skill) } }
        : {}),
      pipeline: {
        approval: {
          request: ({ call, description, preview, modeInvariant }) =>
            this.handleApprovalRequest(
              {
                id: call.callId,
                agentId: this.id,
                mainAgentId: activation.mainAgentId,
                toolName: call.entry.modelName,
                params: call.params as Record<string, unknown>,
                timestamp: new Date(),
                description,
                category:
                  call.entry.identity?.kind === 'skill' && call.entry.identity.domain === 'browser'
                    ? 'browser'
                    : call.entry.identity?.kind === 'skill' &&
                        call.entry.identity.domain === 'local'
                      ? 'local'
                      : 'system',
                preview,
                modeInvariant,
              },
              call.ctx.signal
            ),
        },
      },
    });
  }
}
