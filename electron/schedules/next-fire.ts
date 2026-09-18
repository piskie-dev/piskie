import { Cron } from 'croner';
import {
  isScheduleActive,
  type Schedule,
  type ScheduleTaskState,
} from '../../shared/types/schedules.js';
import { isValidTimeZone } from './local-time.js';

/** 只接受标准 5 字段（分 时 日 月 周）；croner 额外支持的秒字段、年字段与 @daily 别名一律拒绝。 */
export const CRON_FIELD_COUNT = 5;

export type CronProblem = 'field-count' | 'timezone' | 'syntax' | 'never';

export function checkCron(expression: string, timezone: string): CronProblem | null {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== CRON_FIELD_COUNT) return 'field-count';
  if (!isValidTimeZone(timezone)) return 'timezone';
  let cron: Cron;
  try {
    cron = new Cron(fields.join(' '), { timezone });
  } catch {
    return 'syntax';
  }
  return cron.nextRun() ? null : 'never';
}

/** 严格晚于 `after` 的下一个匹配时刻。 */
export function nextCronRun(expression: string, timezone: string, after: Date): Date | null {
  return new Cron(expression.trim(), { timezone }).nextRun(after);
}

/** 不晚于 `before` 的最近一个匹配时刻（含 `before` 所在的整分）。 */
export function latestCronRun(expression: string, timezone: string, before: Date): Date | null {
  const cron = new Cron(expression.trim(), { timezone });
  const [run] = cron.previousRuns(1, new Date(before.getTime() + 1000));
  return run ?? null;
}

/**
 * 下一个计划时刻，不看活跃性：一次性任务就是 `at`；周期任务是锚点之后的首个匹配。
 * 锚点 = max(lastFiredAt, createdAt)，因此每个计划时刻最多触发一次。
 */
export function nextOccurrence(schedule: Schedule, state: ScheduleTaskState): Date | null {
  const { trigger } = schedule;
  if (trigger.kind === 'once') {
    const at = new Date(trigger.at);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const anchor = laterOf(state.lastFiredAt, schedule.createdAt);
  try {
    return nextCronRun(trigger.expression, trigger.timezone, anchor);
  } catch {
    return null;
  }
}

/** 给界面与工具看的下次触发：非活跃任务为 null。 */
export function nextRunAt(schedule: Schedule, state: ScheduleTaskState): Date | null {
  if (!isScheduleActive(schedule, state)) return null;
  return nextOccurrence(schedule, state);
}

function laterOf(left: string | undefined, right: string): Date {
  const rightDate = new Date(right);
  if (!left) return rightDate;
  const leftDate = new Date(left);
  if (Number.isNaN(leftDate.getTime())) return rightDate;
  return leftDate.getTime() > rightDate.getTime() ? leftDate : rightDate;
}
