/**
 * 定时任务页的文案格式化：全部经 Intl 与 t()，组件里不拼日期。
 */

import type { TFunction } from 'i18next';
import type { TaskDefinitionSnapshot } from '@shared/electron-contracts/task-definitions';
import type {
  FireOutcome,
  ScheduleInlineLaunch,
  ScheduleSuspension,
  ScheduleTrigger,
} from '@shared/types/schedules';
import { parseCadence } from './cron-cadence';
import { dayOffset } from './local-days';

export function formatTime(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function formatTimeWithSeconds(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export function formatDateShort(date: Date, locale: string, withYear = false): string {
  return new Intl.DateTimeFormat(locale, {
    ...(withYear ? { year: 'numeric' } : {}),
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function formatWeekdayShort(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
}

export function formatDateLong(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' }).format(date);
}

/** 今天/明天/昨天 + 时刻；更远的日期给月日（跨年给年）。 */
export function formatRelativeDateTime(date: Date, now: Date, locale: string, t: TFunction): string {
  const time = formatTime(date, locale);
  switch (dayOffset(date, now)) {
    case 0:
      return `${t('schedulesUi.day.today')} ${time}`;
    case 1:
      return `${t('schedulesUi.day.tomorrow')} ${time}`;
    case -1:
      return `${t('schedulesUi.day.yesterday')} ${time}`;
    default:
      return `${formatDateShort(date, locale, date.getFullYear() !== now.getFullYear())} ${time}`;
  }
}

export function formatDayHeading(date: Date, now: Date, locale: string, t: TFunction): { title: string; subtitle: string } {
  const long = formatDateLong(date, locale);
  switch (dayOffset(date, now)) {
    case 0:
      return { title: t('schedulesUi.day.today'), subtitle: long };
    case -1:
      return { title: t('schedulesUi.day.yesterday'), subtitle: long };
    default:
      return {
        title: formatDateShort(date, locale, date.getFullYear() !== now.getFullYear()),
        subtitle: formatWeekdayShort(date, locale),
      };
  }
}

function clockText(hour: number, minute: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}`;
}

export function describeCron(expression: string, t: TFunction): string {
  const cadence = parseCadence(expression);
  switch (cadence.kind) {
    case 'daily':
      return t('schedulesUi.cadence.daily', { time: clockText(cadence.hour, cadence.minute) });
    case 'weekdays':
      return t('schedulesUi.cadence.weekdays', { time: clockText(cadence.hour, cadence.minute) });
    case 'weekly':
      return t('schedulesUi.cadence.weekly', {
        weekday: t(`schedulesUi.weekday.${cadence.weekday}`),
        time: clockText(cadence.hour, cadence.minute),
      });
    case 'hourly':
      return t('schedulesUi.cadence.hourly', { minute: String(cadence.minute).padStart(2, '0') });
    case 'everyHours':
      return t('schedulesUi.cadence.everyHours', { every: cadence.every });
    case 'custom':
      return t('schedulesUi.cadence.custom', { expression });
  }
}

export function describeTrigger(trigger: ScheduleTrigger, now: Date, locale: string, t: TFunction): string {
  if (trigger.kind === 'once') {
    return t('schedulesUi.cadence.once', { time: formatRelativeDateTime(new Date(trigger.at), now, locale, t) });
  }
  return describeCron(trigger.expression, t);
}

export function describeSuspension(suspension: ScheduleSuspension, t: TFunction): string {
  switch (suspension.code) {
    case 'consecutive-failures':
      return t('schedulesUi.suspension.consecutiveFailures', { count: suspension.count });
    case 'template-deleted':
      return t('schedulesUi.suspension.templateDeleted');
    case 'target-missing':
      return t('schedulesUi.suspension.targetMissing');
  }
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function describeTemplate(template: TaskDefinitionSnapshot, t: Translate): string {
  return [
    template.workspace
      ? t('schedulesUi.launch.workspace', { path: template.workspace })
      : t('schedulesUi.launch.workspaceDefault'),
    t(`schedulesUi.mode.${template.defaultModeId}`),
    t(`schedulesUi.approval.${template.defaultApprovalMode}`),
    t('schedulesUi.launch.mcp', { count: template.mcpServers?.length ?? 0 }),
  ].join(' · ');
}

export function describeInlineLaunch(launch: ScheduleInlineLaunch, t: Translate): string {
  return [
    launch.workspace
      ? t('schedulesUi.launch.workspace', { path: launch.workspace })
      : t('schedulesUi.launch.workspaceDefault'),
    t(`schedulesUi.approval.${launch.approvalMode}`),
    launch.model ? t('schedulesUi.launch.model', { model: launch.model }) : t('schedulesUi.launch.modelDefault'),
    t('schedulesUi.launch.mcp', { count: launch.mcpServers?.length ?? 0 }),
  ].join(' · ');
}

export function describeOutcome(
  outcome: FireOutcome,
  t: Translate,
): string {
  switch (outcome.kind) {
    case 'started':
      return t('schedulesUi.outcome.started');
    case 'injected':
      return t('schedulesUi.outcome.injected');
    case 'failed':
      return `${t('schedulesUi.outcome.failed')} · ${outcome.message}`;
    case 'skipped':
      return t(outcome.reason === 'overlap' ? 'schedulesUi.outcome.skippedOverlap' : 'schedulesUi.outcome.skippedMissed');
  }
}
