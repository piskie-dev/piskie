import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * SubagentModule — 子流程管理
 *
 * 负责创建、销毁、路由子流程及持久化生命周期。
 */

import type { AgentModule } from './module.js';
import type { AgentEngine } from '../agent-engine.js';
import type { AgentHost } from '../agent-host.js';
import type { ToolContextBuilder } from '../tool-context.js';
import type { AgentInferencePort } from '../../inference/application/agent-inference-port.js';
import { parseModelTargetReference } from '../../inference/execution/model-target.js';
import type { AgentPilotPorts } from '../../core/pilot/index.js';
import type { AgentRuntimeObserver, AgentRuntimeObserverFactory } from '../observations.js';
import type { ImageApplicationPort } from '../../inference/application/image-application-port.js';
import type { ModelTarget } from '../../inference/execution/contracts.js';
import type {
  AssignmentTaskBoardSnapshot,
  TaskItem,
  SubagentConfig,
  SubagentNotification,
  AgentInputEvent,
  AgentInputRequest,
  AgentRunConfig,
  ApprovalMode,
  ToolApprovalDecision,
  ChildSnapshot,
} from '../../../shared/types/index.js';
import { STALLED_CONFIG } from '../../../shared/constants/index.js';
import { neutralizeClosing } from '../prompts/context.js';
import { RuntimeTraceWriter } from '../tracing/runtime-trace-writer.js';
import { createUuid } from '@shared/utils/identifiers.js';
import { deriveWorkerMode, specRegistry } from '../specs/index.js';
import { resolveBrowserBinding, type ResolvedBrowserBinding } from './browser-binding.js';
import {
  normalizeSubagentNotification,
  renderATASubagentEventBody,
  renderSubagentEventOpeningTag,
} from '../ata/ata-event-protocol.js';
import { isATAEventEnvelope } from '../ata/ata-event-envelope.js';

interface SubagentModuleConfig {
  runConfig?: AgentRunConfig;
  allocateAgentId?: () => string;
  createRuntimeObserver?: AgentRuntimeObserverFactory;
  inference?: AgentInferencePort;
  pilotPorts?: {
    skills: AgentPilotPorts['skills'] | null;
    browser: AgentPilotPorts['browser'] | null;
  };
  imageApplication?: ImageApplicationPort;
  imageTarget?: ModelTarget;
}

/**
 * 单个 subagent 的运行时元数据（与 SubagentConfig 解耦，仅 module 内维护）。
 * 生命周期策略由 AgentSpec.lifecycle 声明（策略下沉 Spec）：
 * - onTerminal：终态事件后的处置 — 'grace' 保留宽限期供续任务（默认），'immediate' 立即回收
 * - graceMs：宽限期时长；期间父向子代理发事件即取消回收
 * - deadlineMs：watchdog 硬超时门限（真实活动判据：工具调用与通知都会刷新 lastProgressAt）
 * - stalledAfterMs / stalledReported：stalled 上报门限与边沿触发标记（只上报不销毁）
 * - closureCheckSent：当前输入周期是否已在处置前请求过一次任务状态确认
 * - terminalAt：终态事件落地时间；宽限期回收计时起点
 */
interface SubagentRuntimeMeta {
  onTerminal: 'grace' | 'immediate';
  graceMs: number;
  deadlineMs?: number;
  stalledAfterMs: number;
  stalledReported: boolean;
  closureCheckSent: boolean;
  startedAt: number;
  lastProgressAt: number;
  terminalAt?: number;
  terminalType?: string;
}

/** 终态宽限期默认时长（5 分钟）：终态后保留子代理供父续任务/追问，到期自动回收 */
const DEFAULT_SUBAGENT_GRACE_MS = 5 * 60_000;

/** Watchdog 巡检间隔（30 秒） */
const WATCHDOG_INTERVAL_MS = 30_000;

const CLOSURE_CHECK_MESSAGE = `<closure_check>
请检查当前任务及用户后续提出的要求：
- 已全部完成：单独调用 send_event(type: "completed") 报告完整结果
- 无法完成：单独调用 send_event(type: "failed") 报告原因和已完成部分
- 仍有工作：继续执行
</closure_check>`;

function renderUserInterruptedWorkers(workerIds: readonly string[]): string {
  const prefix = workerIds.length > 1 ? '- ' : '';
  const notices = workerIds.map(
    (id) =>
      `${prefix}${id} 被用户中断，原 ID 仍有效；不要继续等待，仅在后续用户目标需要时向其发送消息。`
  );
  return `<worker_interrupted>\n${notices.join('\n')}\n</worker_interrupted>`;
}

export class SubagentModule implements AgentModule {
  readonly name = 'subagent';
  private host!: AgentHost;

  // 运行时依赖（从 config 注入）
  private runConfig?: AgentRunConfig;
  private allocateAgentId?: () => string;
  private createRuntimeObserver?: AgentRuntimeObserverFactory;
  private inference?: AgentInferencePort;
  private pilotPorts?: AgentPilotPorts;
  private imageApplication?: ImageApplicationPort;
  private imageTarget?: ModelTarget;

  /** 活跃的子流程 Map */
  private subagents: Map<string, AgentEngine> = new Map();
  /** 每个 subagent 的运行时元数据（生命周期策略 / 进度时间戳 / 终态时间） */
  private subagentMeta: Map<string, SubagentRuntimeMeta> = new Map();
  /** Browser Worker 创建期冻结的资源绑定。 */
  private subagentBrowserBindings = new Map<string, ResolvedBrowserBinding>();
  /** 同一 Worker 的并发销毁调用复用同一个 settlement。 */
  private subagentTeardowns = new Map<string, Promise<void>>();
  /** 新 Worker 启动前等待同一 Profile 的前序 Chromium 完成关闭。 */
  private browserTeardowns = new Map<string, Promise<void>>();
  /** Watchdog 定时器（init 时启动，onDestroy 时关闭） */
  private watchdogTimer?: NodeJS.Timeout;
  /** 执行流水记录器（创建子流程或收到 trace 事件时按需实例化） */
  private traceRecorder?: RuntimeTraceWriter;
  private destroyPromise?: Promise<void>;
  /** Parent 整体销毁时保留 Worker 清单，供下次恢复报告中断。 */
  private preserveChildHeaderForParentRecovery = false;

  init(host: AgentHost, config: Record<string, unknown>): void {
    const settings = config as unknown as SubagentModuleConfig | undefined;
    const ports = settings?.pilotPorts;
    Object.assign(this, {
      host,
      runConfig: settings?.runConfig,
      allocateAgentId: settings?.allocateAgentId,
      createRuntimeObserver: settings?.createRuntimeObserver,
      inference: settings?.inference,
      pilotPorts:
        ports?.skills && ports.browser
          ? { skills: ports.skills, browser: ports.browser }
          : undefined,
      imageApplication: settings?.imageApplication,
      imageTarget: settings?.imageTarget,
    });

    // 启动 watchdog：巡检宽限期回收 + 硬超时
    // ⚓ trace 落盘被 L2 系统行为契约断言；生命周期策略只由 Spec 与运行时管理。
    this.watchdogTimer = setInterval(() => {
      this.checkSubagentLifecycles();
    }, WATCHDOG_INTERVAL_MS);
    // 不阻塞进程退出
    this.watchdogTimer.unref?.();
  }

  /** trace 文件路径（不存在记录器时也可预告路径）。 */
  getSubagentTraceFilePath(subagentId: string): string | undefined {
    return this.getTraceRecorder()?.filePathFor(subagentId);
  }

  private getTraceRecorder(): RuntimeTraceWriter | undefined {
    if (!this.traceRecorder) {
      if (!this.host) return undefined;
      const paths = this.host.getConversationStore().paths;
      this.traceRecorder = new RuntimeTraceWriter((workerId) =>
        paths.tracePath({
          agentId: this.host.mainAgentId,
          workerId,
        })
      );
    }
    return this.traceRecorder;
  }

  contributeTools(builder: ToolContextBuilder): void {
    builder
      .setSubagents({
        resolveType: (type: string) => this.resolveWorkerType(type),
        create: (config: SubagentConfig, snapshot: AssignmentTaskBoardSnapshot) =>
          this.createSubagent(config, snapshot),
        destroy: (id: string) => this.destroySubagent(id),
        traceFilePath: (id: string) => this.getSubagentTraceFilePath(id),
      })
      .setEvents({
        allowedTargets: () => Array.from(this.subagents.keys()),
        send: (id: string, event: Record<string, unknown>) => this.sendEventToSubagent(id, event),
        notifyParent: () => false,
      });
  }

  private availableWorkerTypes() {
    return specRegistry.getNamedWorkersForParent(this.host.spec.name);
  }

  private resolveWorkerType(
    type: string
  ): { mode: SubagentConfig['mode']; agentSpec?: string } | { error: string } {
    const namedWorkers = this.availableWorkerTypes();
    const available = ['browser', 'local', ...namedWorkers.map((worker) => worker.name)];
    if (!namedWorkers.some((worker) => worker.name === type)) {
      return {
        error: `未知的子流程类型: ${type}。当前可用 type: ${available.join(' / ')}`,
      };
    }
    const spec = specRegistry.get(type);
    if (!spec) {
      return { error: `子流程类型 ${type} 已从注册表移除，请重新读取当前工具定义` };
    }
    try {
      specRegistry.assertParentMayCreate(this.host.spec.name, spec);
      return { mode: deriveWorkerMode(spec), agentSpec: type };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  processEvent(event: AgentInputEvent): boolean {
    // 处理子流程通知事件
    if (event.source === 'subagent') {
      const input = event.content as Record<string, unknown>;
      const subagentId = input?.subagentId as string;
      const notification = normalizeSubagentNotification(input);
      const notificationType = notification.type;
      const isTerminal =
        notificationType === 'completed' ||
        notificationType === 'failed' ||
        notificationType === 'user_stopped';

      // 子流程事件信封：三种载荷统一为 <subagent_event id type>
      const notificationData = notification.data as Record<string, unknown> | undefined;
      const envelopeBody = isATAEventEnvelope(notificationData)
        ? renderATASubagentEventBody(notificationData)
        : notification.text;

      const ts = new Date(event.timestamp).toISOString();
      const openingTag = renderSubagentEventOpeningTag(subagentId, ts, notification);
      const contextMessage = `${openingTag}\n${neutralizeClosing('subagent_event', envelopeBody)}\n</subagent_event>`;
      this.host.addUserMessage({ text: contextMessage, subtype: 'subagent_notification' });

      // 终态生命周期：上下文已落地后按 spec 策略处置
      // - immediate：立即回收（适合完成后应尽快释放浏览器的专属 Worker）
      // - grace：标记 terminalAt 进入宽限期，父续任务（sendEventToSubagent）即取消回收，
      //   到期由 watchdog 静默回收（父已收到终态事件，不再注入）
      if (isTerminal && this.subagents.has(subagentId)) {
        const meta = this.subagentMeta.get(subagentId);
        if (meta?.onTerminal === 'immediate') {
          this.destroySubagentOrEscalate(
            subagentId,
            notificationType === 'completed' ? 'completed' : 'failed'
          );
        } else if (meta) {
          meta.terminalAt = Date.now();
          meta.terminalType = notificationType;
        }
      }

      // 通知已投影为模型消息，避免 defaultProcessEvent 再写一份普通消息。
      return true;
    }
    return false;
  }

  /** Start child teardown in the parent's destroy-begin phase, before the Main MCP runtime closes. */
  onDestroyBegin(): Promise<void> {
    return this.destroyChildren();
  }

  onDestroy(): Promise<void> {
    return this.destroyChildren();
  }

  private destroyChildren(): Promise<void> {
    return (this.destroyPromise ??= this.performDestroyChildren());
  }

  private async performDestroyChildren(): Promise<void> {
    this.preserveChildHeaderForParentRecovery = true;
    // 先停 watchdog，避免在销毁过程中再次触发
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    // 销毁必须等待真实 settle，不设置额外的不可信超时。
    // destroy 内部各阶段自带超时语义（"不再等待"），进程退出的硬期限交给进程终止。
    // 清理错误不就地吞：allSettled 保证兄弟销毁互不阻断，失败聚合上抛，
    // 由父 runtime 的 finishDestroy 统一收集（"清理失败聚合上抛不阻断释放"）。
    const results = await Promise.allSettled(
      Array.from(this.subagents.entries()).map(async ([subagentId, subagent]: [string, any]) => {
        const startedAt = Date.now();
        await subagent.destroy?.();
        await this.releaseSubagentTasks(subagentId, false);

        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= 1000) {
          appLog.warn({
            event: 'agent.subagent.stop.slow',
            message: 'Subagent stop was slow',
            context: { scope: 'agent.subagent', subagentId, durationMs: elapsedMs },
          });
        }
      })
    );
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    this.subagents.clear();
    this.subagentMeta.clear();
    this.subagentBrowserBindings.clear();
    this.subagentTeardowns.clear();
    this.browserTeardowns.clear();

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `子代理销毁失败 ${failures.length} 个（注册表已清空，销毁互不阻断）`
      );
    }
  }

  listChildAgents(): AgentEngine[] {
    return Array.from(this.subagents.values()) as unknown as AgentEngine[];
  }

  // ─── 公共方法 ──────────────────────────────────────────

  getSubagent(id: string): AgentEngine | undefined {
    return this.subagents.get(id);
  }

  getSubagents(): Map<string, AgentEngine> {
    return this.subagents;
  }

  /**
   * 创建子流程通知处理器
   * @returns 处理器返回投递结果：true = 已入父 Mailbox 或已直达 sync waiter；
   *          false = 父 runtime 已拆除，发送方（send_event 工具）据此报错、不产生 terminal
   */
  createSubagentNotificationHandler(
    subagentId: string
  ): (notification: SubagentNotification) => boolean {
    return (notification: SubagentNotification) => {
      const normalized = normalizeSubagentNotification(notification);
      const isTerminal =
        normalized.type === 'completed' ||
        normalized.type === 'failed' ||
        normalized.type === 'user_stopped';

      // 刷新 lastProgressAt（任何子流程通知到达都视为活着，重置 watchdog 计时）；
      // 终态后又收到非终态通知 = 子代理重新工作，取消宽限期回收
      const meta = this.subagentMeta.get(subagentId);
      if (meta) {
        meta.lastProgressAt = Date.now();
        if (!isTerminal && meta.terminalAt) {
          meta.terminalAt = undefined;
          meta.terminalType = undefined;
        }
      }

      // 执行流水：通知也入 trace（终态与阻断信息对复盘同样关键）
      this.getTraceRecorder()?.recordLifecycle(subagentId, normalized.type, normalized.text);

      // 正常入队，由 processEvent 处理
      const agentInputEvent: AgentInputEvent = {
        id: createUuid(),
        timestamp: new Date(),
        source: 'subagent',
        content: { subagentId, ...normalized },
        priority: normalized.type === 'need_user_action' ? 'high' : 'normal',
        metadata: { notificationType: normalized.type, subagentId },
      };
      return this.host.post(agentInputEvent);
    };
  }

  /** 即时中断子流程 */
  interruptChildImmediately(subagentId: string): Promise<boolean> {
    return this.accessSubagent(subagentId, Promise.resolve(false), async (subagent) => {
      const wasInterrupted = subagent.interrupted;
      const settlement = subagent.instantInterrupt();
      if (!wasInterrupted && subagent.interrupted && !this.host.interrupted) {
        this.notifyUserInterruptedWorkers([subagentId]);
      }
      await settlement;
      this.host.emitStateChange();
      return true;
    });
  }

  /** 只投影本次被用户中断的 Worker，不附带其他 Worker 快照。 */
  notifyUserInterruptedWorkers(workerIds: readonly string[]): void {
    const event = this.createUserInterruptedWorkersEvent(workerIds);
    if (event) this.host.post(event);
  }

  /** Main 恢复时从当前 Worker 注册表派生，不保存第二份中断状态。 */
  buildUserInterruptedWorkersEvent(): AgentInputRequest | undefined {
    return this.createUserInterruptedWorkersEvent(
      Array.from(this.subagents.entries())
        .filter(([, subagent]) => subagent.interrupted)
        .map(([id]) => id)
    );
  }

  private createUserInterruptedWorkersEvent(
    workerIds: readonly string[]
  ): AgentInputRequest | undefined {
    const uniqueIds = [...new Set(workerIds)];
    if (uniqueIds.length === 0) return undefined;
    return { source: 'system', content: renderUserInterruptedWorkers(uniqueIds) };
  }

  /** 设置子流程模型 */
  applyChildModel(subagentId: string, model: string): boolean {
    return this.updateSubagent(subagentId, (subagent) => {
      this.host.getInference().assertTarget(parseModelTargetReference(model));
      subagent.setModel(model);
    });
  }

  applyChildReasoning(
    subagentId: string,
    selection?: import('../../../shared/types/reasoning.js').ReasoningSelection
  ): boolean {
    return this.updateSubagent(subagentId, (subagent) => {
      subagent.setReasoningOverride(selection);
    });
  }

  /** 设置子流程确认模式 */
  applyChildApprovalMode(subagentId: string, mode: ApprovalMode): boolean {
    return this.updateSubagent(subagentId, (subagent) => {
      subagent.setApprovalMode(mode);
    });
  }

  /** 响应子流程工具调用确认 */
  settleChildApproval(subagentId: string, decision: ToolApprovalDecision): boolean {
    return this.accessSubagent(subagentId, false, (subagent) =>
      subagent.respondToApproval(decision)
    );
  }

  private updateSubagent(subagentId: string, mutation: (subagent: AgentEngine) => void): boolean {
    return this.accessSubagent(subagentId, false, (subagent) => {
      mutation(subagent);
      this.host.emitStateChange();
      return true;
    });
  }

  private accessSubagent<T>(
    subagentId: string,
    missing: T,
    access: (subagent: AgentEngine) => T
  ): T {
    const subagent = this.subagents.get(subagentId);
    return subagent === undefined ? missing : access(subagent);
  }

  /** 向子流程注入事件 */
  injectEventToSubagent(subagentId: string, event: AgentInputEvent): boolean {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) {
      return false;
    }
    // 事实先于状态：post 实际送达后才取消宽限期回收
    const delivered = subagent.post(event);
    if (delivered) {
      this.noteSubagentInputDelivered(subagentId);
    }
    return delivered;
  }

  /** 成功投递输入后刷新 watchdog 基线，并取消终态宽限期回收。 */
  private noteSubagentInputDelivered(subagentId: string): void {
    const meta = this.subagentMeta.get(subagentId);
    if (!meta) return;

    meta.lastProgressAt = Date.now();
    meta.stalledReported = false;
    meta.closureCheckSent = false;
    if (meta.terminalAt) {
      meta.terminalAt = undefined;
      meta.terminalType = undefined;
    }
  }

  private publishTaskBoard(board: { taskSummary: string; items: TaskItem[] }): void {
    const planModule = this.host.getModule('plan') as
      { setTaskBoard(value: { taskSummary: string; items: TaskItem[] }): void } | undefined;
    planModule?.setTaskBoard({ taskSummary: board.taskSummary, items: board.items });
  }

  private updatePersistedChildren(update: (children: ChildSnapshot[]) => ChildSnapshot[]): void {
    const store = this.host.getConversationStore();
    const header = store.readHeader(this.host.mainAgentId);
    if (!header) {
      throw new Error(`Cannot update Worker registry: parent header not found (${this.host.id})`);
    }
    store.writeHeader(this.host.mainAgentId, {
      ...header,
      lastActiveAt: new Date().toISOString(),
      childAgents: update(header.childAgents || []),
    });
  }

  private persistCreatedChild(snapshot: ChildSnapshot): void {
    this.updatePersistedChildren((children) => [
      ...children.filter((child) => child.id !== snapshot.id),
      snapshot,
    ]);
  }

  private persistStoppedChild(subagentId: string): void {
    this.updatePersistedChildren((children) => children.filter((child) => child.id !== subagentId));
  }

  private isParentStopping(): boolean {
    return this.preserveChildHeaderForParentRecovery || (this.host.phase as string) === 'stopping';
  }

  // ─── 内部方法 ──────────────────────────────────────────

  private async createSubagent(
    config: SubagentConfig,
    taskBoardSnapshot: AssignmentTaskBoardSnapshot
  ): Promise<string> {
    let id = '';
    let subagent:
      | (AgentEngine & {
          start: () => Promise<unknown>;
          destroy?: () => Promise<void>;
          hasFailed?: () => boolean;
          getFailureReason?: () => string | undefined;
        })
      | undefined;

    if (this.isParentStopping()) {
      return '';
    }

    try {
      const specName = specRegistry.resolveWorkerSpec(config);
      const spec = specRegistry.get(specName);
      if (!spec) {
        throw new Error(`AgentSpec '${specName}' not found in registry`);
      }
      if (spec.role !== 'worker') {
        throw new Error(
          `AgentSpec '${specName}' is not a Worker and cannot be created as a subagent`
        );
      }
      specRegistry.assertParentMayCreate(this.host.spec.name, spec);

      if (!this.allocateAgentId) throw new Error('Agent ID allocator is unavailable');
      id = this.allocateAgentId();
      const browserBinding = spec.modules.includes('browser')
        ? resolveBrowserBinding({
            mainAgentId: this.host.mainAgentId,
            workerId: id,
            browserEnvironmentId: config.browserEnvironmentId,
            shareDirectorBrowser: spec.shareDirectorBrowser,
          })
        : undefined;
      if (browserBinding) {
        await this.waitForBrowserHandoff(browserBinding.userDataId);
        const activeOwner = this.findActiveBrowserBindingOwner(browserBinding.userDataId);
        if (activeOwner) {
          throw new Error(
            `浏览器 Profile ${browserBinding.userDataId} 当前仍由 ${activeOwner} 使用，请先停止该 Worker`
          );
        }
      }

      // Invalid specs are rejected before loading the much heavier runtime graph.
      const { AgentRuntime } = await import('../agent-runtime.js');

      const childAdvancedSettings = config.browserEnvironmentId
        ? undefined
        : this.runConfig?.advancedSettings;

      const applicationObserver = this.createRuntimeObserver?.(id);
      const isCurrentChild = (): boolean => this.subagents.get(id) === subagent;
      const childObserver: AgentRuntimeObserver = {
        stateChanged: () => {
          if (isCurrentChild()) this.host.emitStateChange();
        },
        contentProduced: (event) => {
          if (!isCurrentChild()) return;
          const meta = this.subagentMeta.get(id);
          if (meta && !meta.terminalAt) meta.lastProgressAt = Date.now();
          this.getTraceRecorder()?.recordContentEvent(id, event);
          applicationObserver?.contentProduced(event);
        },
        liveContentProduced: (event) => {
          if (!isCurrentChild()) return;
          applicationObserver?.liveContentProduced(event);
        },
      };

      subagent = new AgentRuntime({
        id,
        spec,
        inference: this.inference as AgentInferencePort,
        pilotPorts: this.pilotPorts,
        conversationStore: this.host.getConversationStore(),
        observer: childObserver,
        options: {
          mainAgentId: this.host.mainAgentId,
          runConfig: this.runConfig,
          subagentConfig: config,
          browserBinding,
          initialModel: this.host.currentModel,
          initialReasoning: this.host.reasoningOverride,
          initialApprovalMode: this.host.approvalMode,
          parentMcpCapability: this.host.getMcpCapabilitySnapshot?.(),
          workspace: this.runConfig?.workspace,
          advancedSettings: childAdvancedSettings,
          imageApplication: this.imageApplication,
          imageTarget: this.imageTarget,
          assignmentTaskBoardSnapshot: taskBoardSnapshot,
          onTaskBoardChange: (board: { taskSummary: string; items: TaskItem[] }) =>
            this.publishTaskBoard(board),
          createRuntimeObserver: this.createRuntimeObserver,
          onNotification: (notification: SubagentNotification) =>
            this.createSubagentNotificationHandler(id)(notification),
        },
      }) as any;

      if (browserBinding) this.subagentBrowserBindings.set(id, browserBinding);
      this.subagents.set(id, subagent!);

      this.host.appendConversationEntry({
        t: 'marker',
        ts: Date.now(),
        key: 'child_created',
        value: {
          id,
          config: {
            subject: config.subject,
            taskIds: config.taskIds,
            mode: config.mode,
            skills: config.skills,
          },
        },
      });

      // 注册运行时元数据 —— 生命周期策略来自 spec.lifecycle
      //（生命周期是 agent 类型的策略，不是 AI 每次调用的决策）
      const nowMs = Date.now();
      this.subagentMeta.set(id, {
        onTerminal: spec.lifecycle?.onTerminal ?? 'grace',
        graceMs: spec.lifecycle?.graceMs ?? DEFAULT_SUBAGENT_GRACE_MS,
        deadlineMs: spec.lifecycle?.deadlineMs,
        stalledAfterMs: spec.lifecycle?.stalledAfterMs ?? STALLED_CONFIG.defaultStalledAfterMs,
        stalledReported: false,
        closureCheckSent: false,
        startedAt: nowMs,
        lastProgressAt: nowMs,
      });

      // 竞争条件检查
      if (this.isParentStopping()) {
        await this.destroySubagent(id, 'parent_stopping');
        return '';
      }

      await subagent!.start();

      // 启动失败检测：start() 内部 catch 后调 markAsFailed()，这里检查并转为同步错误
      // 让 subagent 工具直接通过 tool_result 返回失败，而不是异步通知
      if ((subagent as any).hasFailed?.()) {
        const reason = (subagent as any).getFailureReason?.();
        const failMsg = reason ? `子流程启动失败: ${reason}` : '子流程启动失败';
        await this.destroySubagent(id);
        throw new Error(failMsg);
      }

      // 启动后再检查
      if (this.isParentStopping()) {
        await this.destroySubagent(id);
        return '';
      }

      // subagent 工具会在本方法返回后立即暴露 trace 路径，先落空文件避免读取与首条事件竞态。
      await this.getTraceRecorder()?.initializeFile(id);

      this.persistCreatedChild({
        id,
        config,
        createdAt: nowMs,
      });

      this.host.emitStateChange();
      return id;
    } catch (error) {
      try {
        await this.cleanupFailedSubagentCreation(id, subagent);
      } catch (cleanupError) {
        // 清理失败并入创建失败上抛：引用保留供父 destroy 再消费
        appLog.error({
          event: 'agent.subagent.create.failed',
          message: 'Subagent creation failed',
          context: { scope: 'agent.subagent', subagentId: id, failureStage: 'cleanup' },
          error: new AggregateError([error, cleanupError]),
        });
        throw new AggregateError([error, cleanupError], `子流程创建失败且清理失败: ${id}`);
      }
      appLog.error({
        event: 'agent.subagent.create.failed',
        message: 'Subagent creation failed',
        context: { scope: 'agent.subagent', subagentId: id, failureStage: 'start' },
        error,
      });
      throw error;
    }
  }

  /**
   * 创建失败清理（递归对称）：destroy 成功才删引用。
   * 失败时条目保留——rejected destroyPromise（幂等门闩）留给父 destroy 的 allSettled 再消费，
   * 清理错误原样上抛，由调用方并入创建失败一起上报。
   */
  private async cleanupFailedSubagentCreation(
    subagentId: string,
    subagent?: AgentEngine
  ): Promise<void> {
    const hadRuntimeResidue = this.subagents.has(subagentId);

    if (!hadRuntimeResidue && !subagent) {
      return;
    }

    if (this.subagents.has(subagentId)) {
      await this.destroySubagent(subagentId); // 内部即"destroy 成功才删表"
    } else {
      await (subagent as any)?.destroy?.();
    }
    // destroy 已成功（失败在上面抛出、引用保留）：清余下簿记
    this.subagents.delete(subagentId);
    this.subagentMeta.delete(subagentId);
    this.subagentBrowserBindings.delete(subagentId);
  }

  private async waitForBrowserHandoff(userDataId: string): Promise<void> {
    const teardown = this.browserTeardowns.get(userDataId);
    if (teardown) await teardown;
  }

  private findActiveBrowserBindingOwner(userDataId: string): string | undefined {
    for (const [subagentId, binding] of this.subagentBrowserBindings) {
      if (binding.userDataId === userDataId && this.subagents.has(subagentId)) return subagentId;
    }
    return undefined;
  }

  private destroySubagent(subagentId: string, stopReason?: string, publish = true): Promise<void> {
    const resolvedId = this.resolveSubagentId(subagentId);
    if (!resolvedId) {
      throw new Error(`子流程不存在: ${subagentId}`);
    }
    const existing = this.subagentTeardowns.get(resolvedId);
    if (existing) return existing;

    const binding = this.subagentBrowserBindings.get(resolvedId);
    const teardown = this.performDestroySubagent(resolvedId, stopReason, publish);
    this.subagentTeardowns.set(resolvedId, teardown);
    if (binding) this.browserTeardowns.set(binding.userDataId, teardown);
    void teardown.then(
      () => {
        if (this.subagentTeardowns.get(resolvedId) === teardown) {
          this.subagentTeardowns.delete(resolvedId);
        }
        this.subagentBrowserBindings.delete(resolvedId);
        if (binding && this.browserTeardowns.get(binding.userDataId) === teardown) {
          this.browserTeardowns.delete(binding.userDataId);
        }
      },
      () => undefined
    );
    return teardown;
  }

  private async performDestroySubagent(
    resolvedId: string,
    stopReason: string | undefined,
    publish: boolean
  ): Promise<void> {
    const subagent = this.subagents.get(resolvedId)!;
    await (subagent as any).destroy?.();
    await this.releaseSubagentTasks(resolvedId, publish);

    if (!this.preserveChildHeaderForParentRecovery) {
      this.persistStoppedChild(resolvedId);
    }

    this.subagents.delete(resolvedId);
    this.subagentMeta.delete(resolvedId);

    this.host.appendConversationEntry({
      t: 'marker',
      ts: Date.now(),
      key: 'child_stopped',
      value: { id: resolvedId, stopReason: stopReason || 'destroyed' },
    });

    if (publish) this.host.emitStateChange();
    appLog.info({
      event: 'agent.subagent.stop.completed',
      message: 'Subagent stopped',
      context: { scope: 'agent.subagent', subagentId: resolvedId },
    });
  }

  /** Service/UI 精确停止单个子流程的入口；资源释放仍归子 runtime.destroy。 */
  async stopSubagentById(subagentId: string, stopReason = 'external_stop'): Promise<void> {
    await this.destroySubagent(subagentId, stopReason);
  }

  private async releaseSubagentTasks(subagentId: string, publish: boolean): Promise<void> {
    try {
      const { taskBoardService } = await import('../../agent-runs/task-board-service.js');
      const board = await taskBoardService.releaseOwnerTasks(this.host.id, subagentId);
      if (publish && board) this.publishTaskBoard(board);
    } catch (error) {
      appLog.warn({
        event: 'agent.subagent_tasks.release.degraded',
        message: 'Subagent task release degraded',
        context: { scope: 'agent.subagent_tasks', subagentId },
        error,
      });
    }
  }

  /**
   * 自主回收统一收口：sync 完成 / terminal 立即 / grace 到期 / watchdog
   * 相关路径共用。destroy 失败 → 升级直达通道（host.reportFatalTeardown → Service stopAgent(父)），
   * 不经 Mailbox——升级场景恰是"父可能出事了"，post 会被投递门拒收。
   * 失败不删 registry 条目：错误保留在 rejected destroyPromise 上（destroy 幂等门闩，同一
   * settlement 可反复消费），父 destroy 的 allSettled 再次消费它进父 AggregateError。
   */
  private destroySubagentOrEscalate(subagentId: string, stopReason?: string): void {
    this.destroySubagent(subagentId, stopReason).catch((error) => {
      this.host.reportFatalTeardown(error);
    });
  }

  /** 在首次 idle 处置前唤醒 Worker，让其确认任务终态或继续执行。 */
  private requestClosureCheck(
    subagent: AgentEngine,
    meta: SubagentRuntimeMeta,
    now: number
  ): boolean {
    const delivered = subagent.post({
      source: 'system',
      content: CLOSURE_CHECK_MESSAGE,
    });
    if (!delivered) return false;

    meta.closureCheckSent = true;
    meta.lastProgressAt = now;
    meta.stalledReported = false;
    return true;
  }

  /**
   * Watchdog 巡检（每 30 秒）：
   * 1. 终态宽限期回收：terminalAt 已标记且宽限期用尽 → 静默回收
   *    （父已收到终态事件，无需再注入；期间父续任务会清除 terminalAt 取消回收）
   * 2. 收尾确认：首次达到 stalled/deadline 门限时先唤醒 Worker 确认终态或继续执行；
   * 3. stalled 上报：确认后再次超过 stalledAfterMs 无活动 → 只向父流程上报、不销毁；
   *    边沿触发（每次 stall 仅一次，活动恢复复位），附最后声明（wait reason）
   * 4. 硬超时（卡死判定）：spec 声明了 deadlineMs 且超过该时长无任何活动
   *    （工具调用与通知都刷新 lastProgressAt）→ 注入 failed 事件给父并强制销毁；
   *    与 stalled 是两个独立策略，不共用字段。
   *
   * 设计要点：
   * - 通过事件队列（注入 failed event）让父流程的 processEvent 走正常路径，
   *   保持 sync waiter / context 写入 / 状态变更通知的统一性
   * - 注入完成后 destroy，event handler 看到 subagent 已销毁不影响事件消费
   * - destroy 失败经 destroySubagentOrEscalate 升级直达 Service，不传染主循环
   */
  private checkSubagentLifecycles(): void {
    if (this.subagentMeta.size === 0) return;
    const now = Date.now();
    for (const [id, meta] of this.subagentMeta) {
      // subagent 可能已被销毁但 meta 没清干净（理论不会，仍兜底）
      if (!this.subagents.has(id)) {
        this.subagentMeta.delete(id);
        continue;
      }

      // 1) 终态宽限期回收
      if (meta.terminalAt) {
        if (now - meta.terminalAt > meta.graceMs) {
          this.destroySubagentOrEscalate(
            id,
            meta.terminalType === 'completed' ? 'completed' : meta.terminalType || 'grace_expired'
          );
        }
        // 终态后的静默是预期行为，不做卡死/stalled 判定
        continue;
      }

      const subagent = this.subagents.get(id);
      if (subagent?.interrupted) continue;

      // 2) 在途冲程或从真实关系派生出的 idle permit 不进入 stalled/deadline 判定。
      if (subagent) {
        const hasInFlightWork = subagent.isPumping;
        const hasIdlePermit = subagent.getIdlePermits().length > 0;
        if (hasInFlightWork || hasIdlePermit) {
          meta.stalledReported = false;
          continue;
        }
      }

      const idleMs = now - meta.lastProgressAt;

      // 首次达到任一处置门限时先请求一次语义确认；成功投递后本轮不再上报或销毁。
      const reachedStalledThreshold = idleMs > meta.stalledAfterMs;
      const reachedDeadline = meta.deadlineMs !== undefined && idleMs > meta.deadlineMs;
      if (
        subagent &&
        !meta.closureCheckSent &&
        (reachedStalledThreshold || reachedDeadline) &&
        this.requestClosureCheck(subagent, meta, now)
      ) {
        continue;
      }

      // 3) stalled 上报（只上报不销毁，边沿触发：报过一次后等活动恢复才复位）
      if (reachedStalledThreshold) {
        if (!meta.stalledReported) {
          meta.stalledReported = true;
          this.reportStalledSubagent(id, meta, idleMs);
        }
      } else if (meta.stalledReported) {
        meta.stalledReported = false;
      }

      // 4) 硬超时（idle 卡死判定：Pump 已退出且未声明等待的持续 idle）
      if (!meta.deadlineMs) continue;
      if (!reachedDeadline) continue;
      appLog.warn({
        event: 'agent.subagent.watchdog.timed_out',
        message: 'Subagent inactivity deadline elapsed',
        context: {
          scope: 'agent.subagent',
          subagentId: id,
          idleDurationMs: idleMs,
          deadlineMs: meta.deadlineMs,
        },
      });
      // 1) 先注入 failed 事件给父，让 processEvent 正常消费 + 写上下文
      const failureEvent: AgentInputEvent = {
        id: createUuid(),
        timestamp: new Date(),
        source: 'subagent',
        content: {
          subagentId: id,
          type: 'failed',
          text: `子流程超过 ${Math.round(meta.deadlineMs / 1000)}s 无活动，已被 watchdog 强制终止`,
          data: {
            origin: 'watchdog',
            reason: 'watchdog_timeout',
            idleMs,
            deadlineMs: meta.deadlineMs,
          },
        },
        priority: 'high',
        metadata: { notificationType: 'failed', subagentId: id, watchdogTriggered: true },
      };
      this.host.post(failureEvent);
      // 2) 然后销毁（事件已在队列中，destroy 不影响消费；失败升级）
      this.destroySubagentOrEscalate(id, 'timeout');
    }
  }

  /**
   * stalled 上报：确定性、不调 AI、不销毁。
   * 附带当前派生 permit（正常 stalled 时应为空），入父 Mailbox 走正常事件路径——
   * 由父 director 或用户决定 stop 或追加指令（追加的指令作为真实事件唤醒子代理）。
   */
  private reportStalledSubagent(id: string, meta: SubagentRuntimeMeta, idleMs: number): void {
    const subagent = this.subagents.get(id);
    const permits = subagent?.getIdlePermits() ?? [];
    const lastDeclaration =
      permits.length > 0
        ? permits.map((permit) => permit.kind).join(', ')
        : '无（自然 idle，未声明终态且没有有效等待凭据）';

    appLog.warn({
      event: 'agent.subagent.watchdog.degraded',
      message: 'Subagent inactivity was reported',
      context: {
        scope: 'agent.subagent',
        subagentId: id,
        idleDurationMs: idleMs,
        stalledAfterMs: meta.stalledAfterMs,
        permitKinds: permits.map((permit) => permit.kind),
      },
    });

    const stalledEvent: AgentInputEvent = {
      id: createUuid(),
      timestamp: new Date(),
      source: 'subagent',
      content: {
        subagentId: id,
        type: 'stalled',
        text:
          `子流程已 ${Math.round(idleMs / 1000)}s 无活动（门限 ${Math.round(meta.stalledAfterMs / 1000)}s）。` +
          `最后声明：${lastDeclaration}。仅上报未销毁——可追加指令唤醒，或判定无进展后 stop 回收`,
        data: {
          origin: 'watchdog',
          idleMs,
          stalledAfterMs: meta.stalledAfterMs,
        },
      },
      priority: 'normal',
      metadata: { notificationType: 'stalled', subagentId: id, watchdogTriggered: true },
    };
    this.host.post(stalledEvent);
  }

  /** 解析 subagentId：支持序列号或完整 Worker ID。 */
  private resolveSubagentId(idOrSeq: string): string | undefined {
    // 先尝试精确匹配
    if (this.subagents.has(idOrSeq)) return idOrSeq;
    // 再尝试序列号后缀匹配
    if (!/^\d+$/.test(idOrSeq)) return undefined;
    return Array.from(this.subagents.keys()).find((id) => id.endsWith(`-${idOrSeq}`));
  }

  private sendEventToSubagent(subagentId: string, content: Record<string, unknown>): boolean {
    const resolvedId = this.resolveSubagentId(subagentId);
    const subagent = resolvedId ? this.subagents.get(resolvedId) : undefined;
    if (!subagent || !resolvedId) {
      return false;
    }

    const agentInputEvent: AgentInputEvent = {
      id: createUuid(),
      timestamp: new Date(),
      source: 'parent',
      content,
      priority: 'normal',
      metadata: {
        fromAgentId: this.host.id,
        targetSubagentId: resolvedId,
        originalTargetId: subagentId,
      },
    };

    // 投递结果如实上报：目标已拆除时返回 false，工具边界据此报错。
    // 事实先于状态：post 实际送达后才取消宽限期回收（父续任务信号）
    const delivered = subagent.post(agentInputEvent);
    if (delivered) {
      this.noteSubagentInputDelivered(resolvedId);
    }
    return delivered;
  }
}
