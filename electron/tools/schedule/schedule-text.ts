import type { Schedule, ScheduleTaskState, ScheduleView } from '../../../shared/types/schedules.js';
import { formatLocalDateTime } from '../../schedules/local-time.js';

/** 三个 schedule 工具共用的文案片段，保证模型读到的口径一致。 */

export function describeTrigger(schedule: Schedule, timezone: string): string {
  if (schedule.trigger.kind === 'once') {
    return `一次 ${formatLocalDateTime(new Date(schedule.trigger.at), timezone)}`;
  }
  return `周期 cron「${schedule.trigger.expression}」（${schedule.trigger.timezone}）`;
}

export function describeTarget(schedule: Schedule): string {
  return schedule.action.kind === 'inject' ? '注入会话' : '新建运行';
}

export function describeMissedPolicy(schedule: Schedule): string {
  return schedule.runIfMissed ? '错过补跑' : '错过不补跑';
}

export function describeStatus(schedule: Schedule, state: ScheduleTaskState): string {
  if (state.suspended) {
    switch (state.suspended.code) {
      case 'consecutive-failures':
        return `已挂起（连续 ${state.suspended.count} 次启动失败：${state.suspended.message}）`;
      case 'template-deleted':
        return '已挂起（任务模板已删除）';
      case 'target-missing':
        return '已挂起（目标会话已不存在）';
    }
  }
  if (!schedule.enabled) return '已暂停';
  if (state.firedAt) return '已触发';
  return '活跃';
}

export function describeView(view: ScheduleView, timezone: string, currentAgentId: string): string {
  const { schedule, state } = view;
  const parts = [
    `${schedule.scheduleId}「${schedule.name}」`,
    describeTrigger(schedule, timezone),
    view.nextRunAt ? `下次 ${formatLocalDateTime(new Date(view.nextRunAt), timezone)}` : '无下次触发',
    `目标 ${describeTarget(schedule)}`,
    describeMissedPolicy(schedule),
    `状态 ${describeStatus(schedule, state)}`,
  ];
  if (state.lastFiredAt) parts.push(`上次 ${formatLocalDateTime(new Date(state.lastFiredAt), timezone)}`);
  if (state.consecutiveFailures > 0) parts.push(`连续失败 ${state.consecutiveFailures} 次`);
  if (schedule.createdBy.kind === 'agent' && schedule.createdBy.agentId === currentAgentId) {
    parts.push('本会话创建');
  }
  return parts.join(' · ');
}
