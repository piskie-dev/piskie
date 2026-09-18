import type { AgentRunConfig } from '../../shared/types/index.js';
import type { AgentControlState } from '../../shared/types/agent-control.js';
import {
  isScheduleActive,
  type FireOutcome,
  type FireRecord,
  type Schedule,
  type ScheduleSuspension,
} from '../../shared/types/schedules.js';
import {
  createDirectorRunConfig,
  snapshotTaskDefinition,
} from '../agent/launch/agent-run-config-factory.js';
import type { DirectorLaunchOptions } from '../agent/launch/start-director-run.js';
import { appLog } from '../observability/logging/app-log.js';
import { formatLocalDateTime, systemTimeZone } from './local-time.js';
import { latestCronRun, nextOccurrence, nextRunAt } from './next-fire.js';
import type { SchedulerPorts } from './schedule-ports.js';

/** 到期后这么久内算准点触发；再晚就是「错过」。 */
export const MISSED_GRACE_MS = 5 * 60_000;
/** 没有更近的到期时也按这个周期醒一次，兜住系统时钟跳变。 */
export const HEARTBEAT_MS = 60_000;
/** 上一轮有任务处理抛错时的退避，避免坏盘等持续失败下空转。 */
const ERROR_BACKOFF_MS = 15_000;
export const MAX_CONSECUTIVE_FAILURES = 3;

type FirePlan =
  | { kind: 'start'; runConfig: AgentRunConfig; options: DirectorLaunchOptions }
  | { kind: 'inject'; agentId: string; content: string }
  | { kind: 'template-missing' };

interface SettleEffects {
  /** 周期任务的下次计算锚点；默认取本次处理时刻。 */
  anchor?: Date;
  agentId?: string;
  suspend?: ScheduleSuspension;
}

/**
 * 定时任务引擎：单定时器、逐任务串行评估、每个任务独立 try/catch、状态写前声明。
 * 所有入口经同一条串行队列，tick 与「立即运行」不会交错。
 */
export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private started = false;
  private tickPending = false;
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly ports: SchedulerPorts) {}

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    await this.exclusive(() => this.recoverClaim());
    this.unsubscribe = this.ports.definitions.changes.subscribe(() => this.requestTick());
    this.requestTick();
  }

  /** 合并多次请求为一轮评估；评估结束后重新安排下一次唤醒。 */
  requestTick(): void {
    if (this.disposed || this.tickPending) return;
    this.tickPending = true;
    void this.exclusive(async () => {
      this.tickPending = false;
      await this.tick();
    });
  }

  /** 用户手动触发：不看到期与活跃性，不占计划时刻，但同样受租约约束。 */
  runNow(scheduleId: string): Promise<void> {
    return this.exclusive(async () => {
      const schedule = this.find(scheduleId);
      if (!schedule) throw new Error(`Schedule ${scheduleId} does not exist`);
      await this.fire(schedule, this.now(), true);
    });
  }

  /** 用户重新启用时清除系统挂起与失败计数。 */
  clearSuspension(scheduleId: string): Promise<void> {
    return this.exclusive(async () => {
      const current = this.ports.state.taskState(scheduleId);
      if (!current.suspended && current.consecutiveFailures === 0) return;
      await this.ports.state.updateTask(scheduleId, { suspended: undefined, consecutiveFailures: 0 });
      this.ports.onStateChanged?.();
    });
  }

  /** 用户改了触发方式：从现在重新起算，一次性任务恢复未触发，挂起与失败计数一并清除。 */
  rearm(scheduleId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.ports.state.updateTask(scheduleId, {
        firedAt: undefined,
        lastFiredAt: this.now().toISOString(),
        suspended: undefined,
        consecutiveFailures: 0,
      });
      this.ports.onStateChanged?.();
      this.requestTick();
    });
  }

  /** 定义删除后清理状态与历史。 */
  forget(scheduleId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.ports.state.removeTask(scheduleId);
      await this.ports.history.remove(scheduleId);
      this.ports.onStateChanged?.();
    });
  }

  stop(): void {
    this.disposed = true;
    this.clearTimer();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** 等待队列排空（测试与关停用）。 */
  idle(): Promise<void> {
    return this.queue;
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private now(): Date {
    return this.ports.now?.() ?? new Date();
  }

  private find(scheduleId: string): Schedule | undefined {
    return this.ports.definitions.list().find((schedule) => schedule.scheduleId === scheduleId);
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    this.clearTimer();
    const now = this.now();
    let failed = false;
    for (const schedule of this.ports.definitions.list()) {
      if (this.disposed) return;
      try {
        await this.evaluate(schedule, now);
      } catch (error) {
        failed = true;
        appLog.error({
          event: 'schedules.evaluate.failed',
          message: 'Schedule evaluation failed',
          context: { scope: 'schedules', scheduleId: schedule.scheduleId },
          error,
        });
      }
    }
    this.arm(failed);
  }

  private async evaluate(schedule: Schedule, now: Date): Promise<void> {
    const state = this.ports.state.taskState(schedule.scheduleId);
    if (!isScheduleActive(schedule, state)) return;
    const due = nextOccurrence(schedule, state);
    if (!due || due.getTime() > now.getTime()) return;

    if (now.getTime() - due.getTime() <= MISSED_GRACE_MS) {
      await this.fire(schedule, due, false);
      return;
    }

    const latestMissed = this.latestMissed(schedule, now) ?? due;
    if (schedule.runIfMissed) {
      await this.fire(schedule, latestMissed, false);
      return;
    }
    // 不补跑：一条 skipped 代表整段错过；锚点停在最后一个错过时刻，之后仍在宽限内的到期照常触发。
    await this.settle(schedule, {
      scheduledFor: latestMissed.toISOString(),
      firedAt: now.toISOString(),
      outcome: { kind: 'skipped', reason: 'missed' },
    }, { anchor: latestMissed });
    const following = nextOccurrence(schedule, this.ports.state.taskState(schedule.scheduleId));
    if (following && following.getTime() <= now.getTime()) {
      await this.fire(schedule, following, false);
    }
  }

  private latestMissed(schedule: Schedule, now: Date): Date | null {
    if (schedule.trigger.kind !== 'cron') return null;
    try {
      return latestCronRun(
        schedule.trigger.expression,
        schedule.trigger.timezone,
        new Date(now.getTime() - MISSED_GRACE_MS),
      );
    } catch {
      return null;
    }
  }

  private async fire(schedule: Schedule, scheduledFor: Date, manual: boolean): Promise<void> {
    const now = this.now();
    const state = this.ports.state.taskState(schedule.scheduleId);
    const record = (outcome: FireOutcome): FireRecord => ({
      scheduledFor: scheduledFor.toISOString(),
      firedAt: now.toISOString(),
      outcome,
      ...(manual ? { manual: true as const } : {}),
    });

    // 租约：上一次的运行还在内存里忙着就跳过；只是空闲等待则停掉让位。
    if (schedule.action.kind === 'new_run' && state.lastAgentId) {
      const control = this.ports.agents.controlState(state.lastAgentId);
      if (control) {
        if (isBusy(control)) {
          await this.settle(schedule, record({ kind: 'skipped', reason: 'overlap' }), {});
          return;
        }
        try {
          await this.ports.agents.stop(state.lastAgentId);
        } catch (error) {
          await this.settle(schedule, record({
            kind: 'failed', stage: 'start', message: errorMessage(error),
          }), {});
          return;
        }
      }
    }

    const plan = this.plan(schedule, scheduledFor);
    if (plan.kind === 'template-missing') {
      await this.settle(schedule, record({
        kind: 'failed', stage: 'start', message: 'Task Definition was deleted',
      }), { suspend: { code: 'template-deleted' } });
      return;
    }

    await this.ports.state.apply((draft) => {
      draft.claim = {
        scheduleId: schedule.scheduleId,
        scheduledFor: scheduledFor.toISOString(),
        claimedAt: now.toISOString(),
      };
    });

    if (plan.kind === 'start') {
      try {
        const { agentId } = await this.ports.agents.startRun(plan.runConfig, plan.options);
        await this.settle(schedule, record({ kind: 'started', agentId }), { agentId });
        this.ports.notify?.({
          kind: 'started', scheduleId: schedule.scheduleId, name: schedule.name, agentId,
        });
      } catch (error) {
        await this.settle(schedule, record({
          kind: 'failed', stage: 'start', message: errorMessage(error),
        }), {});
      }
      return;
    }

    let delivered = false;
    let failure: string | undefined;
    try {
      delivered = await this.ports.agents.inject(plan.agentId, plan.content);
    } catch (error) {
      failure = errorMessage(error);
    }
    if (delivered) {
      await this.settle(schedule, record({ kind: 'injected', agentId: plan.agentId }), {});
      return;
    }
    await this.settle(schedule, record({
      kind: 'failed', stage: 'inject', message: failure ?? 'Target session no longer exists',
    }), failure ? {} : { suspend: { code: 'target-missing' } });
  }

  private plan(schedule: Schedule, scheduledFor: Date): FirePlan {
    const timeZone = schedule.trigger.kind === 'cron' ? schedule.trigger.timezone : systemTimeZone();
    const localTime = formatLocalDateTime(scheduledFor, timeZone);
    const action = schedule.action;
    if (action.kind === 'inject') {
      return {
        kind: 'inject',
        agentId: action.agentId,
        content: `定时任务「${schedule.name}」到时触发（计划 ${localTime}）。你创建它时留下的指令：\n\n${action.prompt}`,
      };
    }
    const triggerLine = `此运行由定时任务「${schedule.name}」于 ${localTime} 触发，当前没有用户实时查看；完成后给出自包含的结果说明。`;
    if (action.launch.kind === 'definition') {
      const template = this.ports.templates.get(action.launch.definitionId);
      if (!template) return { kind: 'template-missing' };
      const runConfig = snapshotTaskDefinition(template);
      runConfig.name = schedule.name;
      runConfig.promptTemplate = `${triggerLine}\n\n${template.promptTemplate}`;
      return {
        kind: 'start',
        runConfig,
        options: { modeId: template.defaultModeId, approvalMode: template.defaultApprovalMode },
      };
    }
    if (!('prompt' in action)) {
      throw new Error(`Schedule ${schedule.scheduleId} has an inline launch without a prompt`);
    }
    const runConfig = createDirectorRunConfig(action.prompt, {
      workspace: action.launch.workspace,
      bindings: action.launch.bindings,
      advancedSettings: action.launch.advancedSettings,
      mcpServers: action.launch.mcpServers,
    });
    runConfig.name = schedule.name;
    runConfig.promptTemplate = `${triggerLine}\n\n${action.prompt}`;
    return {
      kind: 'start',
      runConfig,
      options: {
        modeId: 'normal',
        approvalMode: action.launch.approvalMode,
        ...(action.launch.model ? { model: action.launch.model } : {}),
      },
    };
  }

  /** 结果、锚点、租约、挂起与写前声明的清除合并为一次状态写入，再追加一条历史。 */
  private async settle(schedule: Schedule, record: FireRecord, effects: SettleEffects): Promise<void> {
    const scheduleId = schedule.scheduleId;
    let suspendedNow: ScheduleSuspension | undefined;
    await this.ports.state.apply((draft) => {
      delete draft.claim;
      const task = draft.tasks[scheduleId] ?? { consecutiveFailures: 0 };
      draft.tasks[scheduleId] = task;
      if (effects.agentId) task.lastAgentId = effects.agentId;
      if (record.outcome.kind === 'started' || record.outcome.kind === 'injected') {
        task.consecutiveFailures = 0;
      }
      if (record.manual) return;

      if (schedule.trigger.kind === 'once') task.firedAt = record.firedAt;
      else task.lastFiredAt = (effects.anchor ?? new Date(record.firedAt)).toISOString();

      if (record.outcome.kind === 'failed') task.consecutiveFailures += 1;
      if (schedule.trigger.kind !== 'cron' || task.suspended) return;
      if (effects.suspend) {
        suspendedNow = effects.suspend;
      } else if (
        record.outcome.kind === 'failed'
        && task.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
      ) {
        suspendedNow = {
          code: 'consecutive-failures',
          count: task.consecutiveFailures,
          message: record.outcome.message,
        };
      }
      if (suspendedNow) task.suspended = suspendedNow;
    });
    try {
      await this.ports.history.append({ scheduleId, ...record });
    } catch (error) {
      appLog.warn({
        event: 'schedules.history.append.failed',
        message: 'Schedule history could not be written',
        context: { scope: 'schedules', scheduleId },
        error,
      });
    }
    this.ports.onStateChanged?.();
    if (suspendedNow) {
      this.ports.notify?.({
        kind: 'suspended', scheduleId, name: schedule.name, suspension: suspendedNow,
      });
    }
  }

  /** 上次进程在 startAgent 中途退出留下的声明：记 interrupted、锚点前移，不重放。 */
  private async recoverClaim(): Promise<void> {
    const claim = this.ports.state.claim();
    if (!claim) return;
    const schedule = this.find(claim.scheduleId);
    await this.ports.state.apply((draft) => {
      delete draft.claim;
      if (!schedule) return;
      const task = draft.tasks[claim.scheduleId] ?? { consecutiveFailures: 0 };
      draft.tasks[claim.scheduleId] = task;
      if (schedule.trigger.kind === 'once') task.firedAt = claim.claimedAt;
      else task.lastFiredAt = claim.claimedAt;
      task.consecutiveFailures += 1;
    });
    if (!schedule) return;
    await this.ports.history.append({
      scheduleId: claim.scheduleId,
      scheduledFor: claim.scheduledFor,
      firedAt: claim.claimedAt,
      outcome: {
        kind: 'failed',
        stage: 'interrupted',
        message: 'The application exited while this run was starting',
      },
    }).catch(() => undefined);
    this.ports.onStateChanged?.();
  }

  private arm(afterError: boolean): void {
    if (this.disposed) return;
    const nowMs = this.now().getTime();
    let delay = HEARTBEAT_MS;
    for (const schedule of this.ports.definitions.list()) {
      const next = nextRunAt(schedule, this.ports.state.taskState(schedule.scheduleId));
      if (next) delay = Math.min(delay, Math.max(0, next.getTime() - nowMs));
    }
    if (afterError) delay = Math.max(delay, ERROR_BACKOFF_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.requestTick();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function isBusy(control: AgentControlState): boolean {
  return control.phase !== 'waiting'
    || Boolean(control.pendingToolCall)
    || Boolean(control.pendingQuestion);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
