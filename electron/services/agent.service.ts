/**
 * AgentService — Agent 调度服务
 * 管理多个 AgentRuntime 的生命周期（支持并发执行）
 *
 * 核心设计：
 * - activeRuntimes 是唯一真相源：在 Map 中 = 运行中，不在 = 已停止（仅文件存在）
 * - 状态和内容变化通过只读 Agent observations 投影，不依赖全局事件总线
 * - Resume = 读文件 + 创建新 AgentRuntime + replay + start
 * - ⚓ 提示词锚点（agent_run 工具 description）：顶层 AgentRun 在 activeRuntimes 中彼此无父子关系，
 *   不级联、无自动回收——改动此语义需同步 tools/agent/agent-run.tool.ts 的 description 首段
 */

import { AgentRuntime } from '../agent/agent-runtime.js';
import { specRegistry } from '../agent/specs/index.js';
import { ConversationStore } from '../agent-runs/conversation-store.js';
import { agentPilotPorts, browserControlPort } from '../core/pilot/index.js';
import { agentIncidentStore } from '../observability/incidents/agent-incident-store.js';
import type {
  AgentControlState,
  AgentRunHeader,
  ConversationEntry,
} from '../../shared/types/agent-control.js';
import type {
  AgentInputEvent,
  ApprovalMode,
  AgentModeId,
  ToolApprovalDecision,
} from '../../shared/types/index.js';
import type { ResolvedAgentLaunch } from '../agent/launch/resolved-agent-launch.js';
import { appLog } from '../observability/logging/app-log.js';
import { occupancyRegistry } from '../core/occupancy/index.js';
import { app } from 'electron';
import { agentRunTraceService } from '../agent-runs/agent-run-trace-service.js';
import type { AgentInferencePort } from '../inference/application/agent-inference-port.js';
import type { ImageApplicationPort } from '../inference/application/image-application-port.js';
import type { InferenceRuntimeHost } from '../inference/composition/runtime-host.js';
import type { ModelTarget } from '../inference/execution/contracts.js';
import {
  formatModelTarget,
  parseModelTargetReference,
} from '../inference/execution/model-target.js';
import type { Unsubscribe } from '../core/change-channel.js';
import {
  createAgentObservations,
  type AgentObservationSource,
  type AgentRuntimeReleased,
  type AgentRuntimeObserver,
} from '../agent/observations.js';
import { createCompactId } from '@shared/utils/identifiers.js';
import { emptyAgentActivityState } from '../agent/run-metrics.js';

/** 拆除慢观测阈值（仅日志，无任何限时语义） */
const STOP_DESTROY_SLOW_MS = 5000;

export interface AgentServiceRuntimeBindings {
  userDataDirectory?: string;
  inferenceHost: InferenceRuntimeHost;
  agentInference: AgentInferencePort;
  imageApplication: ImageApplicationPort;
}

/**
 * Resume 后注入子 agent 终止通知（doc 21 C3）。
 * 告知 AI 旧子 agent 已终止，避免向失效 ID 发消息。
 */
function childTerminationNoticeId(header: AgentRunHeader): string {
  const workerIds = (header.childAgents || []).map((child) => child.id).sort();
  return `worker-interruption:${workerIds.join('|')}`;
}

function injectChildTerminationNotice(
  runtime: AgentRuntime,
  header: AgentRunHeader,
  entries: readonly ConversationEntry[]
): void {
  // 子 agent 不跨进程存活：header 里记录的都已随卸载/崩溃终止
  const activeChildren = header.childAgents;
  if (activeChildren.length === 0) return;

  const messageId = childTerminationNoticeId(header);
  if (entries.some((entry) => entry.t === 'msg' && entry.id === messageId)) return;

  const notice = activeChildren
    .map((c) => `- ${c.id}`)
    .join('\n');
  runtime.addDurableUserMessage(
    `会话已恢复。以下 Worker 已停止，原 ID 已失效，请勿发送消息：\n${notice}\n\n` +
      '未完成任务已退回 Task Board 未分配区；如需继续，请创建新 Worker。',
    'system_event',
    messageId
  );
}

export class AgentService {
  private activeRuntimes: Map<string, AgentRuntime> = new Map();
  private agentInference: AgentInferencePort | null = null;
  private inferenceHost: InferenceRuntimeHost | null = null;
  private imageApplication: ImageApplicationPort | null = null;
  private initialized = false;
  private conversationStore!: ConversationStore;
  private stopConversationAppends?: Unsubscribe;
  private readonly observationChannel = createAgentObservations((source, error) => {
    appLog.error({
      event: 'agent.observation.publish.failed',
      message: 'Agent observation publication failed',
      context: { scope: 'agent.observation', observationSource: source },
      error,
    });
  });

  readonly observations: AgentObservationSource = this.observationChannel.source;

  private locks = new Map<string, Promise<void>>();

  /**
   * teardown 失败的 AgentRun 单向标记：只回答“这个 AgentRun 曾停止失败吗”。
   * 不持 runtime 引用（引用随摘牌丢弃，能 GC 的尽量 GC）、不存 error（ErrorLog + IPC
   * 返回值已携带）；变迁数 1（只 add），应用重启即清空。消费点只有一个：
   * 锁内生命周期入口 assertRunNotFailed（命中即拒并提示重启）——进不来就动不了那份占用，
   * 保留即隔离，不需要第二处判活。
   */
  private failedTeardowns = new Set<string>();
  private readonly reservedAgentIds = new Set<string>();

  constructor(private readonly createAgentCandidate: () => string = createCompactId) {}

  // ============================================================
  // 生命周期锁：键 = mainAgentId，promise 链 FIFO、非重入
  // 公开方法各取一次锁，锁内只调用不取锁的 *Locked 私有变体。
  // 锁保护世代变更事务（start/stop/resume/delete/lazy restore）；
  // interrupt 不变更世代——锁内确认身份并发起，settle 等待在锁外。
  // ============================================================

  private async withLifecycleLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let resolve: () => void;
    const current = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(key, current);

    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }

  /** 生命周期锁键：mainAgentId（无法解析 owner 时退化为 agentId，仍串行同一会话）。 */
  private lifecycleKey(agentId: string): string {
    return this.resolveMainAgentId(agentId) ?? agentId;
  }

  /** 锁内生命周期入口的失败隔离检查：命中即拒，不允许"当作已释放"建新世代 */
  private assertRunNotFailed(mainAgentId: string): void {
    if (this.failedTeardowns.has(mainAgentId)) {
      throw new Error(
        `该任务此前停止失败（浏览器/设备资源可能未释放），已隔离保护。请重启应用后重试。`
      );
    }
  }

  private allocateAgentId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = `ag-${this.createAgentCandidate()}`;
      if (this.reservedAgentIds.has(candidate) || this.activeRuntimes.has(candidate)) continue;
      if (this.conversationStore.hasAgentId(candidate)) continue;
      this.reservedAgentIds.add(candidate);
      return candidate;
    }
    throw new Error('无法分配唯一 Agent ID');
  }

  /**
   * 升级直达通道的 Service 侧（四条约束）：子代理自主回收 destroy 失败经
   * runtime.reportFatalTeardown 直达此回调——不经 Mailbox、不等 AI/Pump。
   * ① 回调绑定构造时的具体 runtime 实例，先验证世代（旧世代迟到的升级通知不误停新世代）；
   * ② 升级动作 = 现有 stopAgent(父)（排 AgentRun 锁；父 destroy 的 allSettled 再消费同一
   *    rejected destroyPromise → 进 failedTeardowns 隔离）；
   * ③ stopAgent 的 rejection 在此消费并发 UI 错误——升级链不吞错；④ 零新状态。
   */
  private buildFatalTeardownHandler(getRuntime: () => AgentRuntime): (error: unknown) => void {
    return (error: unknown) => {
      const runtime = getRuntime();
      const agentId = runtime.id;
      if (this.activeRuntimes.get(agentId) !== runtime) return;
      appLog.error({
        event: 'agent.teardown.resource.failed',
        message: 'Agent teardown left resources unsettled',
        context: { scope: 'agent.teardown', agentId },
        error,
      });
      this.stopAgent(agentId).catch((stopError) => {
        agentIncidentStore.raise({
          severity: 'error',
          category: 'system',
          source: { agentId },
          message: `子流程销毁失败已升级，停止父流程也失败（资源可能未释放，请重启应用）：${stopError instanceof Error ? stopError.message : String(stopError)}`,
          originalError: String(stopError),
        });
      });
    };
  }

  private createTopLevelRuntimeObserver(
    agentId: string,
    getRuntime: () => AgentRuntime | undefined,
    traceObserver?: Pick<AgentRuntimeObserver, 'contentProduced'>
  ): AgentRuntimeObserver {
    const applicationObserver = this.observationChannel.publisher.observerFor(agentId);
    const isCurrentGeneration = (): boolean => {
      const runtime = getRuntime();
      return runtime !== undefined && this.activeRuntimes.get(agentId) === runtime;
    };
    return {
      stateChanged: (state) => {
        if (!isCurrentGeneration()) {
          return;
        }
        applicationObserver.stateChanged(state);
      },
      contentProduced: (event) => {
        if (!isCurrentGeneration()) {
          return;
        }
        applicationObserver.contentProduced(event);
        try {
          traceObserver?.contentProduced(event);
        } catch (error) {
          appLog.warn({
            event: 'agent.trace.publish.degraded',
            message: 'Agent trace publication degraded',
            context: { scope: 'agent.trace', agentId },
            error,
          });
        }
      },
      liveContentProduced: (event) => {
        if (!isCurrentGeneration()) {
          return;
        }
        applicationObserver.liveContentProduced(event);
      },
    };
  }

  // ============================================================
  // 初始化
  // ============================================================

  async initializeApplication(bindings: AgentServiceRuntimeBindings): Promise<void> {
    this.initializeConversationProjection(bindings.userDataDirectory);
    await this.bindApplicationRuntime(bindings);
  }

  private initializeConversationProjection(userDataDirectory = app.getPath('userData')): void {
    this.conversationStore = new ConversationStore(userDataDirectory);
    // tail -f 推送：条目落盘成功后带行号推给前端（覆盖主/子 runtime 的全部 append）；
    // image_ref 出主进程边界转绝对路径，供渲染进程缩略图直接读取
    this.stopConversationAppends?.();
    this.stopConversationAppends = this.conversationStore.subscribeAppends((change) => {
      this.observationChannel.publisher.conversationAppended({
        agentId: change.agentId,
        index: change.index,
        entry: this.conversationStore.absolutizeImageRefs(
          change.mainAgentId,
          change.agentId,
          change.entry
        ),
        ...(change.requestId && { requestId: change.requestId }),
      });
    });
  }

  private async bindApplicationRuntime(bindings: AgentServiceRuntimeBindings): Promise<void> {
    if (this.initialized) throw new Error('AgentService is already initialized');
    this.inferenceHost = bindings.inferenceHost;
    this.agentInference = bindings.agentInference;
    this.imageApplication = bindings.imageApplication;
    occupancyRegistry.clear();

    this.initialized = true;
  }

  // ============================================================
  // Inference 运行时
  // ============================================================

  private validateModelReference(model: string): void {
    if (!this.agentInference) throw new Error('AgentService not initialized');
    this.agentInference.assertTarget(parseModelTargetReference(model));
  }

  private async readEffectiveInferenceSelections(): Promise<{
    ai?: ModelTarget;
    image?: ModelTarget;
  }> {
    if (!this.inferenceHost) throw new Error('Inference Runtime 未初始化');
    return this.inferenceHost.readEffectiveSelections();
  }

  // ============================================================
  // 启动
  // ============================================================

  async startAgent(launch: ResolvedAgentLaunch): Promise<AgentControlState> {
    if (!this.agentInference) {
      throw new Error('AgentService not initialized');
    }
    const agentId = this.allocateAgentId();
    return this.withLifecycleLock(agentId, () => this.startLocked(agentId, launch));
  }

  /**
   * 唯一激活事务：stage 档案 → prepare → 登记世代凭据 → 启动冲程。
   * 时序不变量：凭据先登记——post start 后 Pump 微任务可能立即执行，onFatalTeardown
   * 世代验证与 onStateChange 的 has() 守卫都要求条目已在牌上；档案（header）先于
   * 启动冲程就绪，且先于 prepare（role.onStart 可能写对话档案）。
   * 失败对称：任一步失败都 destroy，摘牌严格在 destroy settlement 之后——
   * destroy 成功 → 摘牌 + 回滚本次事务的档案；destroy 失败 → failedTeardowns（凭据替代）
   * + 摘牌 + 档案保留（资源未释放，事实需要位置住）+ 聚合上抛。
   */
  private async activateRuntime<T>(
    runtime: AgentRuntime,
    opts: {
      mainAgentId: string;
      /** false = 仅 prepare + 登记，不启动冲程（resume autoStart=false） */
      autoStart?: boolean;
      /** 启动冲程前必须就绪的档案（provisional header 等） */
      stageArtifacts?: () => void;
      /** 失败且 destroy 成功时回滚本次事务产生的档案；resume 不传（保留既有历史） */
      rollbackArtifacts?: () => void;
      /** 首个对外状态也属于激活事务；构造失败必须走同一 teardown/rollback。 */
      buildResult: () => T;
    }
  ): Promise<T> {
    const agentId = runtime.id;
    const { mainAgentId } = opts;

    const failActivation = async (
      activationError: unknown,
      registered: boolean
    ): Promise<never> => {
      let teardownError: unknown;
      try {
        await runtime.destroy(); // prepare 可能已 acquire 租约/开边界——必须 teardown
      } catch (error) {
        teardownError = error;
        this.failedTeardowns.add(mainAgentId);
      }
      if (registered) {
        this.activeRuntimes.delete(agentId); // 摘牌严格在 destroy settlement 之后
      }
      if (teardownError) {
        throw new AggregateError(
          [activationError, teardownError],
          'Runtime activation and teardown both failed'
        );
      }
      if (registered) {
        this.observationChannel.publisher.runtimeReleased({
          agentId,
          reason: 'failed-start',
        });
      }
      opts.rollbackArtifacts?.();
      throw activationError;
    };

    let registered = false;
    try {
      opts.stageArtifacts?.(); // 档案写入也在失败边界内，抛错时执行同一套失败回滚。
      await runtime.prepare();
      this.activeRuntimes.set(agentId, runtime);
      registered = true;
      if (opts.autoStart !== false) {
        await runtime.start(); // prepare 已幂等完成，此处即启动冲程（post start）
      }
      return opts.buildResult();
    } catch (activationError) {
      return await failActivation(activationError, registered);
    }
  }

  /** 锁内启动：拿到锁时注册表要么有 live runtime、要么干净地没有 */
  private async startLocked(
    agentId: string,
    launch: ResolvedAgentLaunch
  ): Promise<AgentControlState> {
    this.assertRunNotFailed(agentId);

    const selections = await this.readEffectiveInferenceSelections();
    const initialModel =
      launch.launchOptions?.initialModel || selectedModelReference(selections.ai);
    if (!initialModel) {
      throw new Error('未配置 AI 模型，请在设置页面配置 Provider 和默认模型');
    }
    this.validateModelReference(initialModel);

    const mainAgentId = agentId;
    let runtime!: AgentRuntime;

    try {
      const traceObserver = await agentRunTraceService.attach(mainAgentId);
      runtime = new AgentRuntime({
        id: agentId,
        spec: launch.agentSpec,
        inference: this.agentInference!,
        pilotPorts: agentPilotPorts,
        conversationStore: this.conversationStore,
        observer: this.createTopLevelRuntimeObserver(agentId, () => runtime, traceObserver),
        options: {
          mainAgentId,
          runConfig: launch.runConfig,
          initialModeId: launch.initialModeId,
          initialApprovalMode: launch.initialApprovalMode,
          initialModel,
          mcpPrewarmToken: launch.launchOptions?.mcpPrewarmToken,
          images: launch.launchOptions?.images,
          allocateAgentId: () => this.allocateAgentId(),
          createRuntimeObserver: (runtimeId) =>
            this.observationChannel.publisher.observerFor(runtimeId),
          imageApplication: this.imageApplication || undefined,
          imageTarget: selections.image,
          onFatalTeardown: this.buildFatalTeardownHandler(() => runtime),
        },
      });

      const state = await this.activateRuntime(runtime, {
        mainAgentId,
        stageArtifacts: () => {
          this.conversationStore.writeHeader(mainAgentId, {
            agentId,
            agentSpec: launch.agentSpec.name,
            modeId: launch.initialModeId,
            runConfig: launch.runConfig,
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            currentModel: initialModel,
            approvalMode: launch.initialApprovalMode,
            childAgents: [],
          });
        },
        rollbackArtifacts: () => {
          this.conversationStore.deleteAgentRun(mainAgentId);
        },
        buildResult: () => runtime.getControlState(),
      });
      appLog.info({
        event: 'agent.runtime.start.completed',
        message: 'Agent runtime started',
        context: {
          scope: 'agent.runtime',
          agentId,
          mainAgentId,
          agentCount: this.activeRuntimes.size,
        },
      });
      return state;
    } catch (error) {
      agentRunTraceService.recordLifecycle(
        mainAgentId,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      await this.detachAgentRunTrace(mainAgentId, 'start_failed');
      if (!this.failedTeardowns.has(mainAgentId)) {
        this.conversationStore.deleteAgentRun(mainAgentId);
      }
      appLog.error({
        event: 'agent.runtime.start.failed',
        message: 'Agent runtime start failed',
        context: { scope: 'agent.runtime', agentId, mainAgentId },
        error,
      });
      throw error;
    }
  }

  // ============================================================
  // 停止
  // ============================================================

  /**
   * 停止：返回 = 停止已完成（destroy settle + 摘牌）；失败 = 诚实失败
   * （rejection 上抛给调用方/IPC，AgentRun 进 failedTeardowns 隔离，占用不释放）。
   */
  async stopAgent(agentId: string): Promise<void> {
    return this.withLifecycleLock(this.lifecycleKey(agentId), () => this.stopLocked(agentId));
  }

  /** 精确停止一个 Worker，并与其顶层 AgentRun 生命周期操作串行。 */
  async stopSubagent(subagentId: string): Promise<void> {
    const owner = this.findSubagentOwner(subagentId);
    if (!owner) throw new Error(`子流程不存在或已停止: ${subagentId}`);

    return this.withLifecycleLock(owner.runtime.mainAgentId, async () => {
      const current = this.activeRuntimes.get(owner.agentId);
      if (current !== owner.runtime)
        throw new Error(`Worker 所属顶层 AgentRun 已停止: ${subagentId}`);
      const module = current.getModule('subagent') as
        | {
            getSubagent(id: string): unknown;
            stopSubagentById(id: string, reason?: string): Promise<void>;
          }
        | undefined;
      if (!module?.getSubagent(subagentId)) throw new Error(`子流程不存在或已停止: ${subagentId}`);
      await module.stopSubagentById(subagentId, 'environment_stop');
    });
  }

  private findSubagentOwner(subagentId: string): { agentId: string; runtime: AgentRuntime } | null {
    for (const [agentId, runtime] of this.activeRuntimes) {
      const module = runtime.getModule('subagent') as
        { getSubagent(id: string): unknown } | undefined;
      if (module?.getSubagent(subagentId)) return { agentId, runtime };
    }
    return null;
  }

  private async stopLocked(
    agentId: string,
    releaseReason: AgentRuntimeReleased['reason'] = 'stopped',
    reportResult = true
  ): Promise<void> {
    const runtime = this.activeRuntimes.get(agentId);
    const mainAgentId = runtime?.mainAgentId ?? this.resolveMainAgentId(agentId) ?? agentId;
    this.assertRunNotFailed(mainAgentId);
    const stopStartedAt = Date.now();

    if (runtime) {
      // destroy 前快照 header（children 仍在，模块销毁后拿不到）
      this.conversationStore.writeHeader(mainAgentId, runtime.buildHeader());

      // destroy 同步前缀先关闭入口；release 只在 teardown 成功并完成摘牌后发布。
      const destroyPromise = runtime.destroy();

      // One threshold event is enough to locate a stuck teardown; the final event carries duration.
      const slowTimer = reportResult
        ? setTimeout(() => {
            appLog.warn({
              event: 'agent.runtime.stop.slow',
              message: 'Agent runtime stop was slow',
              context: {
                scope: 'agent.runtime',
                agentId,
                durationMs: Date.now() - stopStartedAt,
              },
            });
          }, STOP_DESTROY_SLOW_MS)
        : undefined;

      try {
        await destroyPromise; // ★ rejection 不吞：destroy 失败 = teardown 不变量未建立
      } catch (error) {
        // 失败隔离：照常摘牌（引用不被任何表持有，能 GC 的尽量 GC）+ 单向标记 +
        // 占用不释放（releaseResources 仅 errors 为空时执行，保留即隔离）+ ErrorLog 保留
        this.failedTeardowns.add(mainAgentId);
        this.activeRuntimes.delete(agentId);
        agentRunTraceService.recordLifecycle(
          mainAgentId,
          'stop_failed',
          error instanceof Error ? error.message : String(error)
        );
        await this.detachAgentRunTrace(mainAgentId, 'stop_failed');
        if (reportResult) {
          appLog.error({
            event: 'agent.runtime.stop.failed',
            message: 'Agent runtime stop failed',
            context: { scope: 'agent.runtime', agentId, mainAgentId },
            error,
          });
        }
        throw error;
      } finally {
        if (slowTimer) clearTimeout(slowTimer);
      }

      // 以下仅在 destroy 成功（凭据齐全）后执行：事实 → 清理 → 摘牌
      agentIncidentStore.clearAgent(agentId);
      this.activeRuntimes.delete(agentId);
      this.observationChannel.publisher.runtimeReleased({
        agentId,
        reason: releaseReason,
      });
      agentRunTraceService.recordLifecycle(mainAgentId, 'stopped');
      await this.detachAgentRunTrace(mainAgentId, 'stopped');
      if (reportResult) {
        appLog.info({
          event: 'agent.runtime.stop.completed',
          message: 'Agent runtime stopped',
          context: {
            scope: 'agent.runtime',
            agentId,
            remainingAgentCount: this.activeRuntimes.size,
            durationMs: Date.now() - stopStartedAt,
          },
        });
      }
      return;
    }

    // persisted-only：无活 runtime、无活边界 ⇒ 占用必是孤儿，直接回收。
    const header = this.conversationStore.readHeader(mainAgentId);
    if (!header) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    occupancyRegistry.releaseAllOwnedBy(agentId);
    agentIncidentStore.clearAgent(agentId);
    this.observationChannel.publisher.runtimeReleased({
      agentId,
      reason: releaseReason,
    });
    if (reportResult) {
      appLog.info({
        event: 'agent.runtime.stop.completed',
        message: 'Agent runtime stopped',
        context: {
          scope: 'agent.runtime',
          agentId,
          remainingAgentCount: this.activeRuntimes.size,
          durationMs: Date.now() - stopStartedAt,
        },
      });
    }
  }

  async deleteAgentRun(agentId: string): Promise<void> {
    return this.withLifecycleLock(agentId, async () => {
      this.assertRunNotFailed(agentId);
      const wasActive = this.activeRuntimes.has(agentId);
      const hadPersistedSession = this.conversationStore.readHeader(agentId) !== null;
      if (!wasActive && !hadPersistedSession) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      if (wasActive) {
        await this.stopLocked(agentId, 'deleted');
      } else {
        occupancyRegistry.releaseAllOwnedBy(agentId);
        agentIncidentStore.clearAgent(agentId);
      }
      const cleanupErrors: unknown[] = [];
      const failedTargets: string[] = [];
      const browserOwnerIds = [agentId, ...this.conversationStore.listWorkerIds(agentId)];
      for (const ownerId of browserOwnerIds) {
        try {
          await browserControlPort.deleteUserDataById(ownerId);
        } catch (error) {
          cleanupErrors.push(error);
          failedTargets.push(`browser_data:${ownerId}`);
        }
      }
      try {
        this.conversationStore.deleteAgentRun(agentId);
      } catch (error) {
        cleanupErrors.push(error);
        failedTargets.push('agent_run');
      }
      if (!wasActive && hadPersistedSession) {
        this.observationChannel.publisher.runtimeReleased({ agentId, reason: 'deleted' });
      }
      if (cleanupErrors.length > 0) {
        appLog.warn({
          event: 'agent.session.delete.degraded',
          message: 'Agent session deletion degraded',
          context: {
            scope: 'agent.session',
            agentId,
            failedTargets,
          },
          error: new AggregateError(cleanupErrors),
        });
      } else {
        appLog.info({
          event: 'agent.session.delete.completed',
          message: 'Agent session deleted',
          context: { scope: 'agent.session', agentId },
        });
      }
    });
  }

  // ============================================================
  // 中断（可恢复）
  // ============================================================

  /**
   * 即时中断：interrupt 不变更世代——锁内只确认身份并发起（同步前缀已生效），
   * settle 等待在锁外。否则挂死时 stopAgent 排锁后"升级停止"死锁不可达。
   * settlement 包对象防 promise 自动展平（生命周期串行器的 return await 会等穿嵌套 promise）。
   * 在途 AI 请求的取消由 runtime.instantInterrupt 内的冲程 signal 完成。
   */
  async instantInterrupt(agentId: string): Promise<void> {
    const { settlement } = await this.withLifecycleLock(this.lifecycleKey(agentId), async () => {
      const runtime = this.activeRuntimes.get(agentId);
      if (!runtime) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return { settlement: runtime.instantInterrupt() };
    });
    await settlement; // ★ 锁外等待
    appLog.info({
      event: 'agent.runtime.interrupt.completed',
      message: 'Runtime interrupt completed',
      context: { scope: 'agent.runtime', agentId: agentId },
    });
  }

  async instantInterruptSubagent(mainAgentId: string, subagentId: string): Promise<boolean> {
    const { settlement } = await this.withLifecycleLock(
      this.lifecycleKey(mainAgentId),
      async () => {
        const runtime = this.activeRuntimes.get(mainAgentId);
        if (!runtime) {
          throw new Error(`MainAgent '${mainAgentId}' not found`);
        }
        return { settlement: runtime.instantInterruptSubagent(subagentId) };
      }
    );
    const result = await settlement; // ★ 锁外等待（子代理同构）
    if (!result) {
      throw new Error(`Subagent '${subagentId}' not found`);
    }
    appLog.info({
      event: 'agent.runtime.interrupt.completed',
      message: 'Runtime interrupt completed',
      context: { scope: 'agent.runtime', mainAgentId: mainAgentId, subagentId: subagentId },
    });
    return result;
  }

  async resumeAgent(
    agentId: string,
    options?: { autoStart?: boolean }
  ): Promise<AgentControlState | null> {
    return this.withLifecycleLock(this.lifecycleKey(agentId), () =>
      this.resumeLocked(agentId, options)
    );
  }

  /**
   * 锁内恢复：世代变更事务在锁内完成。
   * 旧 isDisposed 世代 barrier 已删——stopLocked 在锁内 await destroy settle 后才摘牌，
   * 因此锁内可见的 activeRuntimes 条目要么是活世代（直接续用），要么不存在（走文件恢复）；
   * "draining 中的旧世代"这一中间态在锁内不可见。
   */
  private async resumeLocked(
    agentId: string,
    options?: { autoStart?: boolean }
  ): Promise<AgentControlState | null> {
    const knownMainAgentId = this.resolveMainAgentId(agentId);
    if (knownMainAgentId) {
      this.assertRunNotFailed(knownMainAgentId);
    }

    const existingRuntime = this.activeRuntimes.get(agentId);

    if (existingRuntime) {
      return existingRuntime.getControlState();
    }

    // Path B: 从文件恢复 — 读 header + JSONL → 创建新 runtime → replay → start
    const mainAgentId = knownMainAgentId;
    if (!mainAgentId) return null;

    if (mainAgentId !== agentId) return null;
    const header = this.conversationStore.readHeader(mainAgentId);
    if (!header) return null;

    if (!this.agentInference) {
      throw new Error('AgentService not initialized');
    }
    this.validateModelReference(header.currentModel);
    const selections = await this.readEffectiveInferenceSelections();

    const specName = header.agentSpec;
    const spec = specRegistry.get(specName);
    if (!spec) {
      throw new Error(`AgentSpec '${specName}' not found in registry`);
    }

    const entries = this.conversationStore.read(mainAgentId, agentId);

    // Worker runtimes are never restored. Re-open their unfinished obligations
    // before PlanModule rebuilds its disposable UI projection.
    const { taskBoardService } = await import('../agent-runs/task-board-service.js');
    await taskBoardService.releaseStaleWorkerTasks(mainAgentId);

    const runConfig = header.runConfig;
    let runtime!: AgentRuntime;
    try {
      const traceObserver = await agentRunTraceService.attach(mainAgentId);
      runtime = new AgentRuntime({
        id: agentId,
        spec,
        inference: this.agentInference,
        pilotPorts: agentPilotPorts,
        conversationStore: this.conversationStore,
        observer: this.createTopLevelRuntimeObserver(agentId, () => runtime, traceObserver),
        options: {
          mainAgentId,
          runConfig,
          initialModeId: header.modeId,
          initialModel: header.currentModel,
          initialApprovalMode: header.approvalMode,
          isResume: true,
          allocateAgentId: () => this.allocateAgentId(),
          createRuntimeObserver: (runtimeId) =>
            this.observationChannel.publisher.observerFor(runtimeId),
          imageApplication: this.imageApplication || undefined,
          imageTarget: selections.image,
          onFatalTeardown: this.buildFatalTeardownHandler(() => runtime),
        },
      });

      await runtime.replayConversation(entries);
      // 尾部修复：replay 后在内存上做，与实时模型边界守卫同一函数同一分类；
      // 合法 pending ask 保持未配对（incoming 用户消息完成它），有修复写入则 flush
      runtime.repairConversationTail();
      injectChildTerminationNotice(runtime, header, entries);

      // 激活事务：resume 失败保留既有历史（档案不是本次事务的产物），
      // 故不传 rollbackArtifacts；autoStart=false 时环境准备仍完整执行（工具链/技能文档/
      // 模块），仅不启动冲程——否则后续 injectEvent 重启循环时工具链是空的
      const state = await this.activateRuntime(runtime, {
        mainAgentId,
        autoStart: options?.autoStart !== false,
        stageArtifacts: () => {
          // 恢复 = 重新活跃，刷新 lastActiveAt（历史列表排序依据）
          this.conversationStore.writeHeader(mainAgentId, {
            ...header,
            lastActiveAt: new Date().toISOString(),
            childAgents: [],
          });
        },
        buildResult: () => runtime.getControlState(),
      });
      appLog.info({
        event: 'agent.runtime.restore.completed',
        message: 'Agent runtime restored',
        context: { scope: 'agent.runtime', agentId, mainAgentId },
      });
      return state;
    } catch (error) {
      agentRunTraceService.recordLifecycle(
        mainAgentId,
        'resume_failed',
        error instanceof Error ? error.message : String(error)
      );
      await this.detachAgentRunTrace(mainAgentId, 'resume_failed');
      throw error;
    }
  }

  // ============================================================
  // 状态查询
  // ============================================================

  getAgent(agentId: string): AgentRuntime | undefined {
    return this.activeRuntimes.get(agentId);
  }

  findAgentById(agentId: string): AgentRuntime | undefined {
    const coordinator = this.activeRuntimes.get(agentId);
    if (coordinator) return coordinator;
    for (const runtime of this.activeRuntimes.values()) {
      const subModule = runtime.getModule('subagent') as
        { getSubagent(id: string): unknown } | undefined;
      const sub = subModule?.getSubagent(agentId);
      if (sub && sub instanceof AgentRuntime) return sub;
    }
    return undefined;
  }

  promoteToolToBackground(callId: string): boolean {
    for (const runtime of this.activeRuntimes.values()) {
      if (runtime.promoteToolToBackground(callId)) return true;
      for (const child of runtime.listChildAgents()) {
        if (child.promoteToolToBackground(callId)) return true;
      }
    }
    return false;
  }

  /** 实时控制状态 — 仅已加载（在跑）的会话；未加载返回 null（在牌即活） */
  getControlState(agentId: string): AgentControlState | null {
    const runtime = this.activeRuntimes.get(agentId);
    if (!runtime) return null;
    return runtime.getControlState();
  }

  /**
   * 从磁盘 header + 对话行数合成历史预览。
   * 只读展示用（phase 恒为 waiting），不代表运行状态——运行状态只存在于 getControlState。
   */
  buildHistoryPreview(agentId: string): AgentControlState | null {
    const mainAgentId = this.resolveMainAgentId(agentId);
    if (!mainAgentId) return null;

    if (mainAgentId !== agentId) return null;
    const header = this.conversationStore.readHeader(mainAgentId);
    if (!header) return null;

    const convLength = this.conversationStore.count(mainAgentId, agentId);
    let reasoningSnapshot: import('../../shared/types/reasoning.js').ReasoningSelection = {
      kind: 'provider-default',
    };
    try {
      if (header.currentModel && this.agentInference) {
        reasoningSnapshot = this.agentInference.resolveReasoning(
          parseModelTargetReference(header.currentModel)
        ).selection;
      }
    } catch {
      // 历史模型可能已被删除；预览仍保持可读，真正恢复时会返回精确配置错误。
    }
    return {
      agentId,
      phase: 'waiting',
      currentModel: header.currentModel,
      reasoningOverride: reasoningSnapshot,
      approvalMode: header.approvalMode,
      modeId: header.modeId,
      ...emptyAgentActivityState(),
      conversationLength: convLength,
      children: [],
      pendingEvents: [],
      agentSpec: header.agentSpec,
      runConfig: header.runConfig,
      createdAt: header.createdAt,
    };
  }

  hasAgentInMemory(agentId: string): boolean {
    return this.activeRuntimes.has(agentId);
  }

  /** 所有已加载会话的实时控制状态 */
  getLoadedControlStates(): Record<string, AgentControlState> {
    const result: Record<string, AgentControlState> = {};
    for (const [id, runtime] of this.activeRuntimes) {
      result[id] = runtime.getControlState();
    }
    return result;
  }

  // ============================================================
  // 事件注入
  // ============================================================

  /**
   * 投递门式：先尝试投递，被拒（disposed 拒收）或不在内存才 lazy restore 再投。
   * 消费"投递事实"而非预查状态——post 返回 false 与 runtime 不存在同构处理，无 TOCTOU 窗口。
   */
  async injectEventToAgent(agentId: string, event: AgentInputEvent): Promise<boolean> {
    // post 是事件唯一写入点：归一化在入口内完成，返回是否被接收
    const runtime = this.activeRuntimes.get(agentId);
    if (runtime && runtime.post(event)) {
      return true;
    }

    const state = await this.resumeAgent(agentId, { autoStart: false });
    if (!state) {
      appLog.warn({
        event: 'agent.event.inject.rejected',
        message: 'Agent event injection was rejected',
        context: {
          scope: 'agent.event',
          agentId,
          reason: 'runtime_restore_unavailable',
        },
      });
      return false;
    }
    return this.activeRuntimes.get(agentId)!.post(event);
  }

  async injectEventToSubagent(
    agentId: string,
    subagentId: string,
    event: AgentInputEvent
  ): Promise<boolean> {
    let runtime = this.activeRuntimes.get(agentId);
    if (!runtime) {
      const state = await this.resumeAgent(agentId, { autoStart: false });
      if (!state) {
        appLog.warn({
          event: 'agent.event.inject.rejected',
          message: 'Agent event injection was rejected',
          context: {
            scope: 'agent.event',
            agentId,
            subagentId,
            reason: 'runtime_restore_unavailable',
          },
        });
        return false;
      }
      runtime = this.activeRuntimes.get(agentId)!;
    }

    return runtime.injectEventToSubagent(subagentId, event);
  }

  // ============================================================
  // Agent 配置变更
  // ============================================================

  setAgentModel(agentId: string, model: string): boolean {
    const runtime = this.activeRuntimes.get(agentId);
    if (!runtime) {
      return false;
    }
    this.validateModelReference(model);
    runtime.setModel(model);
    return true;
  }

  setAgentReasoning(
    agentId: string,
    selection?: import('../../shared/types/reasoning.js').ReasoningSelection
  ): boolean {
    const runtime = this.activeRuntimes.get(agentId);
    if (!runtime) {
      return false;
    }
    runtime.setReasoningOverride(selection);
    return true;
  }

  setSubagentModel(agentId: string, subagentId: string, model: string): boolean {
    const runtime = this.activeRuntimes.get(agentId);
    if (!runtime) {
      return false;
    }
    return runtime.setSubagentModel(subagentId, model);
  }

  setSubagentReasoning(
    agentId: string,
    subagentId: string,
    selection?: import('../../shared/types/reasoning.js').ReasoningSelection
  ): boolean {
    const runtime = this.activeRuntimes.get(agentId);
    if (!runtime) {
      return false;
    }
    return runtime.setSubagentReasoning(subagentId, selection);
  }

  setAgentApprovalMode(agentId: string, mode: ApprovalMode): boolean {
    const runtime = this.activeRuntimes.get(agentId);
    if (!runtime) {
      return false;
    }
    runtime.setApprovalMode(mode);
    return true;
  }

  setSubagentApprovalMode(agentId: string, subagentId: string, mode: ApprovalMode): boolean {
    const runtime = this.activeRuntimes.get(agentId);
    if (!runtime) {
      return false;
    }
    return runtime.setSubagentApprovalMode(subagentId, mode);
  }

  async respondToApproval(
    agentId: string,
    subagentId: string | null,
    decision: ToolApprovalDecision
  ): Promise<boolean> {
    return this.withLifecycleLock(agentId, async () => {
      const runtime = this.activeRuntimes.get(agentId);
      if (!runtime) {
        return false;
      }

      if (subagentId) {
        return runtime.respondToSubagentApproval(subagentId, decision);
      } else {
        return runtime.respondToApproval(decision);
      }
    });
  }

  setMode(agentId: string, mode: AgentModeId): boolean {
    const runtime = this.activeRuntimes.get(agentId);
    if (!runtime) {
      return false;
    }
    runtime.setMode(mode);
    return true;
  }

  // ============================================================
  // 应用关闭
  // ============================================================

  async destroyApplication(): Promise<void> {
    // 应用关闭 = 对全部存活 runtime 执行 destroy（三个调用方之一）：
    // conversation 已实时落盘（Write-Before-Emit），重开后 resume 从盘重建新 runtime。
    // 销毁必须等待真实 settle，不设置额外的不可信超时；
    // 进程退出的硬期限交给进程终止，避免 leaseManager 在 runtime 归还前被拆（use-after-free）
    const results = await Promise.allSettled(
      Array.from(this.activeRuntimes.entries()).map(async ([id, runtime]) => {
        const errors: unknown[] = [];
        // destroy 前快照 header（children 仍在）；在牌即活——
        // stopLocked 摘牌前 await settle，牌上不存在 disposed 条目，无条件快照
        try {
          this.conversationStore.writeHeader(runtime.mainAgentId, runtime.buildHeader());
        } catch (error) {
          errors.push(error);
        }
        let destroyed = false;
        await runtime
          .destroy()
          .then(() => {
            destroyed = true;
          })
          .catch((error) => {
            errors.push(error);
          });
        if (destroyed) {
          this.activeRuntimes.delete(id);
          this.observationChannel.publisher.runtimeReleased({
            agentId: id,
            reason: 'shutdown',
          });
        }
        agentRunTraceService.recordLifecycle(runtime.mainAgentId, 'app_shutdown');
        await this.detachAgentRunTrace(runtime.mainAgentId, 'app_shutdown');
        if (errors.length > 0) {
          throw new AggregateError(errors, `Failed to destroy agent ${id} during shutdown`);
        }
      })
    );
    this.stopConversationAppends?.();
    this.stopConversationAppends = undefined;

    // await 全部 runtime destroy 之后才清空占用登记（清理权顺序）
    if (this.activeRuntimes.size === 0) occupancyRegistry.clear();
    this.initialized = false;
    this.inferenceHost = null;
    this.agentInference = null;
    this.imageApplication = null;
    this.reservedAgentIds.clear();

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'AgentService shutdown left one or more runtimes unsettled'
      );
    }
  }

  lifecycleSnapshot(): {
    initialized: boolean;
    activeRuntimeIds: readonly string[];
    inferenceBound: boolean;
  } {
    return Object.freeze({
      initialized: this.initialized,
      activeRuntimeIds: Object.freeze([...this.activeRuntimes.keys()]),
      inferenceBound: this.inferenceHost !== null,
    });
  }

  // ============================================================
  // 内部工具方法
  // ============================================================

  private async detachAgentRunTrace(mainAgentId: string, phase: string): Promise<void> {
    try {
      await agentRunTraceService.detach(mainAgentId);
    } catch (error) {
      // Trace 是旁路审计产物，刷盘失败不能改写已经成立的 Agent 生命周期结果。
      appLog.warn({
        event: 'agent_run.trace.detach.degraded',
        message: 'AgentRun trace detachment degraded',
        context: { scope: 'agent_run.trace', mainAgentId, lifecyclePhase: phase },
        error,
      });
    }
  }

  resolveMainAgentId(agentId: string): string | null {
    return (
      this.findAgentById(agentId)?.mainAgentId ?? this.conversationStore.findMainAgentId(agentId)
    );
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }
}

function selectedModelReference(target: ModelTarget | undefined): string | undefined {
  return target ? formatModelTarget(target) : undefined;
}

// 单例导出
export const agentService = new AgentService();
