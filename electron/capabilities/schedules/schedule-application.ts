import type { ConfigHost } from '../../config/host/config-host.js';
import { applyConfigPatch, escapeConfigPointer } from '../../config/host/config-mutations.js';
import type { ScheduleStore } from '../../core/storage/schedule-store.js';
import type { TaskDefinitionStore } from '../../core/storage/task-definition-store.js';
import { appLog } from '../../observability/logging/app-log.js';
import type { SchedulerHandle } from '../../runtime/components/scheduler.component.js';
import { nextRunAt } from '../../schedules/next-fire.js';
import type { SchedulePort } from '../../tools/types.js';
import { createCompactId } from '../../../shared/utils/identifiers.js';
import type {
  ScheduleChangeEvent,
  ScheduleCreateInput,
  ScheduleHistoryQuery,
  ScheduleUpdateInput,
} from '../../../shared/electron-contracts/schedules.js';
import type {
  Schedule,
  ScheduleCreator,
  ScheduleFireRecord,
  SchedulesSnapshot,
  ScheduleView,
} from '../../../shared/types/schedules.js';
import { PublicOperationError } from '../public-errors.js';

type StoredSchedule = Omit<Schedule, 'scheduleId'>;
type WritableSchedule = Omit<StoredSchedule, 'createdAt'>;
interface SchedulesDocument {
  revision: number;
  schedules: Record<string, StoredSchedule>;
}

/** 已触发的一次性任务保留这么久后自动清理。 */
const FIRED_ONCE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
const SCHEDULE_ID_PREFIX = 'sch-';

export class ScheduleApplication {
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly dependencies: {
      config: ConfigHost;
      definitions: ScheduleStore;
      templates: TaskDefinitionStore;
      scheduler: SchedulerHandle;
      now?: () => Date;
    },
  ) {}

  list(): SchedulesSnapshot {
    return { items: this.dependencies.definitions.list().map((schedule) => this.view(schedule)) };
  }

  async create(
    input: ScheduleCreateInput,
    createdBy: ScheduleCreator = { kind: 'user' },
  ): Promise<ScheduleView> {
    const submitted: WritableSchedule = {
      name: input.name,
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      runIfMissed: input.runIfMissed,
      action: input.action,
      createdBy,
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.dependencies.config.show<SchedulesDocument>('schedules');
      const scheduleId = this.allocateId(current);
      const value = this.project(scheduleId, submitted);
      try {
        const result = await applyConfigPatch<SchedulesDocument>(
          this.dependencies.config,
          'schedules',
          [{ op: 'add', path: `/schedules/${escapeConfigPointer(scheduleId)}`, value }],
          current.revision,
        );
        return this.view({ scheduleId, ...result.current.schedules[scheduleId]! });
      } catch (error) {
        if (isRevisionConflict(error)) continue;
        throw toPublicError(error);
      }
    }
    throw new PublicOperationError('conflict', 'Unable to create Schedule after concurrent configuration changes');
  }

  async update(scheduleId: string, updates: ScheduleUpdateInput): Promise<ScheduleView> {
    const current = await this.dependencies.config.show<SchedulesDocument>('schedules');
    const existing = current.schedules[scheduleId];
    if (!existing) throw new PublicOperationError('not-found', 'Schedule was not found');

    const submitted: WritableSchedule = { ...withoutCreatedAt(existing), ...updates };
    const value = this.project(scheduleId, submitted);
    let result;
    try {
      result = await applyConfigPatch<SchedulesDocument>(
        this.dependencies.config,
        'schedules',
        [{ op: 'replace', path: `/schedules/${escapeConfigPointer(scheduleId)}`, value }],
        current.revision,
      );
    } catch (error) {
      throw toPublicError(error);
    }

    const { scheduler } = this.dependencies.scheduler;
    if (updates.trigger && !sameJson(updates.trigger, existing.trigger)) {
      await scheduler.rearm(scheduleId);
    } else if (
      updates.enabled === true
      || (updates.action && !sameJson(updates.action, existing.action))
    ) {
      await scheduler.clearSuspension(scheduleId);
    }
    return this.view({ scheduleId, ...result.current.schedules[scheduleId]! });
  }

  async delete(scheduleId: string): Promise<void> {
    if (!this.dependencies.definitions.get(scheduleId)) {
      throw new PublicOperationError('not-found', 'Schedule was not found');
    }
    await applyConfigPatch(this.dependencies.config, 'schedules', [{
      op: 'remove',
      path: `/schedules/${escapeConfigPointer(scheduleId)}`,
    }]);
    await this.dependencies.scheduler.scheduler.forget(scheduleId);
  }

  async runNow(scheduleId: string): Promise<void> {
    if (!this.dependencies.definitions.get(scheduleId)) {
      throw new PublicOperationError('not-found', 'Schedule was not found');
    }
    await this.dependencies.scheduler.scheduler.runNow(scheduleId);
  }

  async queryHistory(query: ScheduleHistoryQuery): Promise<ScheduleFireRecord[]> {
    if (Number.isNaN(Date.parse(query.from)) || Number.isNaN(Date.parse(query.to))) {
      throw new PublicOperationError('invalid-input', 'History range must be ISO timestamps');
    }
    return this.dependencies.scheduler.history.query(query);
  }

  /** 定义或状态变化推完整快照，触发与挂起推通知。 */
  subscribe(listener: (event: ScheduleChangeEvent) => void, signal: AbortSignal): () => void {
    const { definitions, scheduler } = this.dependencies;
    const emitSnapshot = (): void => listener({ kind: 'snapshot', snapshot: this.list() });
    const disposers = [
      definitions.changes.subscribe(emitSnapshot, { signal }),
      scheduler.stateChanges.subscribe(emitSnapshot, { signal }),
      scheduler.notices.subscribe((notice) => listener({ kind: 'notice', notice }), { signal }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  /** 启动后台清理：已触发超过保留期的一次性任务自动删除。 */
  start(): void {
    if (this.cleanupTimer) return;
    void this.cleanupFiredOnce();
    this.cleanupTimer = setInterval(() => {
      void this.cleanupFiredOnce();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  dispose(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  /** 给 Agent 工具用的端口：创建者由调用方标明。 */
  toolPort(): SchedulePort {
    return {
      create: (input, createdBy) => this.create(input, createdBy),
      list: async () => this.list().items,
      cancel: async (scheduleId) => {
        if (!this.dependencies.definitions.get(scheduleId)) return false;
        await this.delete(scheduleId);
        return true;
      },
    };
  }

  private view(schedule: Schedule): ScheduleView {
    const state = this.dependencies.scheduler.state.taskState(schedule.scheduleId);
    return {
      schedule,
      state,
      nextRunAt: nextRunAt(schedule, state)?.toISOString() ?? null,
    };
  }

  private allocateId(current: SchedulesDocument): string {
    for (;;) {
      const candidate = `${SCHEDULE_ID_PREFIX}${createCompactId()}`;
      if (!Object.hasOwn(current.schedules, candidate)) return candidate;
    }
  }

  private project(scheduleId: string, submitted: WritableSchedule): WritableSchedule {
    try {
      return this.dependencies.config.projectWrite<{
        schedules: Record<string, WritableSchedule>;
      }>('schedules', { schedules: { [scheduleId]: submitted } }).schedules[scheduleId]!;
    } catch (error) {
      throw toPublicError(error);
    }
  }

  private async cleanupFiredOnce(): Promise<void> {
    const now = (this.dependencies.now?.() ?? new Date()).getTime();
    for (const schedule of this.dependencies.definitions.list()) {
      if (schedule.trigger.kind !== 'once') continue;
      const { firedAt } = this.dependencies.scheduler.state.taskState(schedule.scheduleId);
      if (!firedAt || now - Date.parse(firedAt) < FIRED_ONCE_RETENTION_MS) continue;
      try {
        await this.delete(schedule.scheduleId);
      } catch (error) {
        appLog.warn({
          event: 'schedules.cleanup.failed',
          message: 'Fired one-off Schedule could not be removed',
          context: { scope: 'schedules', scheduleId: schedule.scheduleId },
          error,
        });
      }
    }
  }
}

function withoutCreatedAt(schedule: StoredSchedule): WritableSchedule {
  const { createdAt: _createdAt, ...value } = schedule;
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRevisionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = Reflect.get(error, 'code');
  return code === 'CONFIG_REVISION_CONFLICT'
    || code === 'CONFIG_PLAN_REVISION_CHANGED'
    || code === 'CONFIG_PLAN_BASE_REVISION_MISMATCH';
}

/** 配置校验失败暴露为 invalid-input，并带上首条问题的说明。 */
function toPublicError(error: unknown): unknown {
  if (error instanceof PublicOperationError) return error;
  if (typeof error !== 'object' || error === null) return error;
  if (Reflect.get(error, 'code') !== 'CONFIG_VALIDATION_FAILED') return error;
  const details = Reflect.get(error, 'details');
  const validation = typeof details === 'object' && details !== null
    ? Reflect.get(details, 'validation')
    : undefined;
  const issues = typeof validation === 'object' && validation !== null
    ? Reflect.get(validation, 'issues')
    : undefined;
  const first = Array.isArray(issues) ? issues.find((issue) => issue?.severity !== 'warning') : undefined;
  const message = typeof first?.message === 'string'
    ? first.message
    : (error instanceof Error ? error.message : 'Schedule is invalid');
  return new PublicOperationError('invalid-input', message, {
    details: first ? { code: first.code, path: first.path } : undefined,
  });
}
