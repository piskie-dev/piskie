import { appLog } from '@electron/observability/logging/app-log.js';
import { linkAbort } from '../utils/abort.js';
import type { MessagingConnectionConfig, BotState } from '@shared/types/im-gateway.js';

/**
 * Auto-restart backoff policy — mirrors OpenClaw's CHANNEL_RESTART_POLICY
 * (src/gateway/server-channels.ts:18-24)
 */
const RESTART_POLICY = {
  initialMs: 5_000, // 首次重启延迟：5 秒
  maxMs: 5 * 60_000, // 最大延迟：5 分钟
  factor: 2, // 指数退避因子
  jitter: 0.1, // ±10% 抖动
};
const MAX_RESTART_ATTEMPTS = 10;

/** Connector 停止完成 barrier 的固定 deadline（不可配置） */
export const CONNECTOR_STOP_TIMEOUT_MS = 10_000;

/** Compute backoff delay with jitter */
function computeBackoff(attempt: number): number {
  const raw = Math.min(
    RESTART_POLICY.initialMs * Math.pow(RESTART_POLICY.factor, attempt - 1),
    RESTART_POLICY.maxMs
  );
  const jitter = raw * RESTART_POLICY.jitter * (Math.random() * 2 - 1);
  return Math.round(raw + jitter);
}

/** Sleep that can be aborted（linkAbort 习语：正常 settle 也 dispose，不留悬挂 listener） */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // timer 先于 linkAbort 声明——pre-aborted 时 fn 同步执行，倒序是 TDZ
    const timer = setTimeout(() => {
      disposeAbort();
      resolve();
    }, ms);
    const disposeAbort = linkAbort(signal, () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

/**
 * 每 bot 至多一个的本地执行对象。
 * 覆盖 deferred start、当前 Connector 长驻调用和自动重连 backoff task；
 * 结束回调以对象身份（CAS）识别，替代"按裸 botId 查询全局当前值"。
 * 不进入 ConnectorContext、消息、ReplyBinding、Agent Session 或磁盘。
 */
export interface AccountExecution {
  readonly config: MessagingConnectionConfig;
  readonly abortController: AbortController;
  /** Connector Promise resolve/reject/finally 三种出口规范化为同一个 settled */
  readonly settled: Promise<void>;
  readonly phase: 'starting' | 'connector' | 'backoff';
  stopRequested: boolean;
}

interface InternalExecution extends AccountExecution {
  /** 解析 settled；幂等 */
  markSettled(): void;
}

/**
 * Manages bot account lifecycles with auto-restart.
 *
 * Like OpenClaw Gateway (server-channels.ts), when a connector's start()
 * Promise resolves or rejects unexpectedly, the account is automatically
 * restarted with exponential backoff. Manual stopBot() prevents auto-restart
 * and consumes the "长驻 Promise settle = 账号已停止" contract as a real barrier.
 */
export class AccountManager {
  private botStates = new Map<string, BotState>();
  private onStatusChange?: (botId: string, state: BotState) => void;

  /** 每 bot 至多一个当前执行；不存在 = 静止（允许改绑/启动） */
  private currentExecutions = new Map<string, InternalExecution>();
  /** 并发 stopBot 复用同一停止等待（同一 execution 只有一个 timer/一次状态迁移） */
  private stopWaits = new Map<string, { execution: InternalExecution; wait: Promise<void> }>();

  /** Restart attempt counters — reset on successful start */
  private restartAttempts = new Map<string, number>();
  /** Cached start fn for auto-restart（自动重连使用旧启动快照，不回读持久配置） */
  private startParams = new Map<
    string,
    {
      config: MessagingConnectionConfig;
      startFn: (signal: AbortSignal) => Promise<unknown>;
    }
  >();

  constructor(opts?: { onStatusChange?: (botId: string, state: BotState) => void }) {
    this.onStatusChange = opts?.onStatusChange;
  }

  /**
   * 是否静止（允许修改 Task Definition 绑定或开始新的 Connector）。
   * 权威条件：currentExecutions 中不存在该 bot 的执行。
   * stopped 必然静止；普通终态 error 在执行清除后也静止；stop_failed 必然不静止。
   */
  isConnectorQuiescent(botId: string): boolean {
    return !this.currentExecutions.has(botId);
  }

  private createExecution(
    config: MessagingConnectionConfig,
    phase: AccountExecution['phase']
  ): InternalExecution {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let settledFlag = false;
    return {
      config,
      abortController: new AbortController(),
      settled,
      phase,
      stopRequested: false,
      markSettled: () => {
        if (settledFlag) return;
        settledFlag = true;
        resolveSettled();
      },
    };
  }

  /**
   * 同步安装 starting reservation（必须在任何 await/setImmediate 前调用）。
   * 已有执行（含 stop_failed 残留）一律拒绝，不提供 force-start 旁路。
   */
  reserveStarting(config: MessagingConnectionConfig): AccountExecution {
    const id = config.id;
    if (this.currentExecutions.has(id)) {
      throw new Error(`Bot ${id} 已有执行中的启动/连接/停止，请先停止后再启动`);
    }
    const execution = this.createExecution(config, 'starting');
    this.currentExecutions.set(id, execution);
    this.updateState(id, {
      config,
      status: 'starting',
      startedAt: new Date().toISOString(),
    });
    return execution;
  }

  /**
   * 启动失败收尾：CAS 命中才清除执行并发布 error（终态 error 清除执行后即静止）。
   */
  failExecution(execution: AccountExecution, error: string): void {
    const internal = execution as InternalExecution;
    internal.markSettled();
    const id = execution.config.id;
    if (this.currentExecutions.get(id) === internal) {
      this.currentExecutions.delete(id);
      this.updateState(id, {
        config: execution.config,
        status: 'error',
        error,
      });
    }
  }

  /**
   * Start a bot backed by a built-in ChannelConnector。
   * startFn 返回长驻 Promise，settle = 账号停止；
   * 意外结束时（非手动停止）按指数退避自动重启。
   *
   * opts.reservation：Gateway 在连接前同步安装的 starting reservation；
   * 不提供时本方法自行同步安装（同样在任何 await 前）。
   */
  async startConnector(
    botConfig: MessagingConnectionConfig,
    startFn: (signal: AbortSignal) => Promise<unknown>,
    opts?: { reservation?: AccountExecution; preserveRestartAttempts?: boolean }
  ): Promise<void> {
    return this.startWithFn(botConfig, startFn, {
      expected: opts?.reservation as InternalExecution | undefined,
      preserveRestartAttempts: opts?.preserveRestartAttempts,
    });
  }

  private async startWithFn(
    botConfig: MessagingConnectionConfig,
    startFn: (signal: AbortSignal) => Promise<unknown>,
    opts?: { expected?: InternalExecution; preserveRestartAttempts?: boolean }
  ): Promise<void> {
    const { id } = botConfig;

    let expected = opts?.expected;
    if (expected) {
      // CAS：已被替换/清理的旧回调直接 no-op，不覆盖后来执行
      if (this.currentExecutions.get(id) !== expected) return;
      // stop 已请求：排队 callback 不得在 stopped 之后重新启动 Connector
      if (expected.stopRequested) {
        expected.markSettled();
        return;
      }
    } else {
      // 同步安装 reservation；已有执行一律拒绝
      expected = this.reserveStarting(botConfig) as InternalExecution;
    }

    // starting/backoff -> connector：以对象身份 CAS 替换
    const execution = this.createExecution(botConfig, 'connector');
    if (this.currentExecutions.get(id) !== expected) return;
    this.currentExecutions.set(id, execution);
    expected.markSettled();

    // Cache params for auto-restart（自动重连使用本次启动快照）
    this.startParams.set(id, { config: botConfig, startFn });
    if (!opts?.preserveRestartAttempts) {
      this.restartAttempts.delete(id);
    }

    this.updateState(id, {
      config: botConfig,
      status: 'starting',
      startedAt: this.botStates.get(id)?.startedAt ?? new Date().toISOString(),
    });

    try {
      // startFn returns a Promise that stays alive while the account is running.
      // When it resolves/rejects, the account has stopped (connector finally 已执行).
      const accountPromise = startFn(execution.abortController.signal);

      // Mark as running immediately after start doesn't throw synchronously
      this.updateState(id, {
        config: botConfig,
        status: 'running',
        startedAt: this.botStates.get(id)?.startedAt,
      });

      // resolve/reject 规范化为同一个 settled，再走结束回调
      accountPromise.then(
        () => {
          execution.markSettled();
          void this.onAccountEnded(id, execution, undefined);
        },
        (err: Error) => {
          execution.markSettled();
          void this.onAccountEnded(id, execution, err);
        }
      );
    } catch (error: any) {
      this.failExecution(execution, error?.message || 'Failed to start bot');
      throw error;
    }
  }

  /**
   * Called when connector's start() Promise ends.
   * 必须携带 expectedExecution；CAS 不命中（已被替换/清理）直接 no-op。
   */
  private async onAccountEnded(
    botId: string,
    expectedExecution: InternalExecution,
    error?: Error
  ): Promise<void> {
    // 旧执行迟到回调：不读取、覆盖或重启后来执行
    if (this.currentExecutions.get(botId) !== expectedExecution) return;

    // 手动停止（stopRequested/abort）：stopBot 的 barrier 负责移除执行并发布 stopped
    if (expectedExecution.stopRequested || expectedExecution.abortController.signal.aborted) return;

    const attempt = (this.restartAttempts.get(botId) ?? 0) + 1;
    this.restartAttempts.set(botId, attempt);

    if (attempt > MAX_RESTART_ATTEMPTS) {
      appLog.error({
        event: 'messaging.connector.restart.failed',
        message: 'Messaging connector restart failed',
        context: {
          scope: 'messaging.connector',
          botId: botId,
          restartCount: MAX_RESTART_ATTEMPTS,
        },
        error,
      });
      this.restartAttempts.delete(botId);
      // 终态 error：清除执行 → 静止（允许改绑/重新启动）
      this.currentExecutions.delete(botId);
      this.updateState(botId, {
        config: expectedExecution.config,
        status: 'error',
        error: `Stopped after ${MAX_RESTART_ATTEMPTS} restart attempts`,
      });
      return;
    }

    // connector -> backoff：以对象身份 CAS 替换（上方已确认当前 === expected，且此处仍同步）
    const backoffExecution = this.createExecution(expectedExecution.config, 'backoff');
    this.currentExecutions.set(botId, backoffExecution);

    const delayMs = computeBackoff(attempt);

    // backoff 沿用 starting + 重连文案展示，不增加公开 backoff 状态
    this.updateState(botId, {
      config: backoffExecution.config,
      status: 'starting',
      startedAt: this.botStates.get(botId)?.startedAt,
      error: `Restarting (attempt ${attempt}/${MAX_RESTART_ATTEMPTS})...`,
    });

    try {
      await sleepWithAbort(delayMs, backoffExecution.abortController.signal);
    } catch {
      // backoff 被 abort（手动停止）：settle，stopBot 负责移除与发布 stopped
      backoffExecution.markSettled();
      return;
    }

    // sleep 正常完成后仍须确认未被停止/替换
    if (backoffExecution.stopRequested) {
      backoffExecution.markSettled();
      return;
    }
    if (this.currentExecutions.get(botId) !== backoffExecution) {
      backoffExecution.markSettled();
      return;
    }

    const params = this.startParams.get(botId);
    if (!params) {
      appLog.error({
        event: 'messaging.connector.restart.failed',
        message: 'Messaging connector restart failed',
        context: {
          scope: 'messaging.connector',
          botId: botId,
          reason: 'restart_parameters_missing',
        },
      });
      backoffExecution.markSettled();
      this.currentExecutions.delete(botId);
      return;
    }

    // backoff -> connector：交棒（startWithFn 内部 CAS 替换并 settle 本 backoff execution）
    try {
      await this.startWithFn(params.config, params.startFn, {
        expected: backoffExecution,
        preserveRestartAttempts: true,
      });
    } catch {
      // start failed — failExecution 已发布 error
    }
  }

  /**
   * Stop a bot — 真正的停止完成 barrier。
   *
   * 固定顺序：读取执行（无则幂等发布 stopped）→ stopRequested → 发布 stopping →
   * abort → 等待 settled 最长 10 秒 → settle: CAS 移除 + 发布 stopped；
   * timeout: 保留执行、发布 stop_failed、抛 connector_stop_timeout（无重启建议）。
   */
  async stopBot(botId: string): Promise<void> {
    const execution = this.currentExecutions.get(botId);
    if (!execution) {
      // 没有执行：幂等发布 stopped
      const state = this.botStates.get(botId);
      if (state && state.status !== 'stopped') {
        this.updateState(botId, { config: state.config, status: 'stopped' });
      }
      return;
    }

    // 并发 stopBot 复用同一停止等待（不重复 timer/迁移）
    const existing = this.stopWaits.get(botId);
    if (existing && existing.execution === execution) {
      return existing.wait;
    }

    const wait = this.performStop(botId, execution);
    this.stopWaits.set(botId, { execution, wait });
    try {
      await wait;
    } finally {
      if (this.stopWaits.get(botId)?.wait === wait) {
        this.stopWaits.delete(botId);
      }
    }
  }

  private async performStop(botId: string, execution: InternalExecution): Promise<void> {
    execution.stopRequested = true;
    this.restartAttempts.delete(botId);

    this.updateState(botId, {
      config: execution.config,
      status: 'stopping',
      startedAt: this.botStates.get(botId)?.startedAt,
    });

    execution.abortController.abort();

    const timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), CONNECTOR_STOP_TIMEOUT_MS);
      void execution.settled.then(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (timedOut) {
      // 保留当前执行（仍不静止），发布 stop_failed；不提供 force-start 旁路
      this.updateState(botId, {
        config: execution.config,
        status: 'stop_failed',
        error: 'connector_stop_timeout',
      });
      // 旧执行以后真实 settle 时：expected execution CAS 命中则清理并自动转为 stopped
      void execution.settled.then(() => {
        if (this.currentExecutions.get(botId) === execution) {
          this.currentExecutions.delete(botId);
          this.updateState(botId, { config: execution.config, status: 'stopped' });
        }
      });
      throw new Error('connector_stop_timeout');
    }

    // settle：按对象身份移除当前执行，发布 stopped
    if (this.currentExecutions.get(botId) === execution) {
      this.currentExecutions.delete(botId);
    }
    this.updateState(botId, { config: execution.config, status: 'stopped' });
  }

  /**
   * 发布配置错误终态（Task Definition 不可用时 Bot 进入明确配置错误）。
   * 仅在静止（无当前执行）时发布——运行中/停止中的状态语义由生命周期状态机负责，
   * 不被外部配置事件覆盖。
   */
  publishConfigError(config: MessagingConnectionConfig, error: string): void {
    if (this.currentExecutions.has(config.id)) return;
    this.updateState(config.id, { config, status: 'error', error });
  }

  /** Get all bot states */
  getAllBotStates(): Map<string, BotState> {
    return new Map(this.botStates);
  }

  /** Update bot state and notify */
  private updateState(botId: string, state: BotState): void {
    this.botStates.set(botId, state);
    this.onStatusChange?.(botId, state);
  }

  /**
   * Cleanup all bots.
   * 先对全部当前执行同步置 stopRequested 并 Abort，再 allSettled 并行等待各自
   * 有界停止；单个 timeout 不阻止其他 Bot 收到 Abort，也不提前清空 currentExecutions
   * 伪造 settle。应用级退出由 main.ts 现有总 deadline 兜底。
   */
  async destroy(): Promise<void> {
    const botIds: string[] = [];
    for (const [botId, execution] of this.currentExecutions) {
      execution.stopRequested = true;
      execution.abortController.abort();
      botIds.push(botId);
    }
    await Promise.allSettled(botIds.map((botId) => this.stopBot(botId)));

    this.botStates.clear();
    this.startParams.clear();
    this.restartAttempts.clear();
    this.stopWaits.clear();
  }
}
