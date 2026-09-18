import { BaseTool } from '../base-tool.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { formatLocalDateTime, systemTimeZone } from '../../schedules/local-time.js';
import { scheduleListSchema, type ScheduleListParams } from './schedule-contract.js';
import { describeView } from './schedule-text.js';

export class ScheduleListTool extends BaseTool<ScheduleListParams> {
  readonly def: ToolDef<ScheduleListParams> = {
    name: 'schedule_list',
    scope: 'main',
    effects: [],
    schema: scheduleListSchema,
    description: '列出全部定时任务：ID、名称、触发形式、下次触发的本地时间、目标、错过策略、状态，并标出由本会话创建的任务。',
  };

  async execute(_params: ScheduleListParams, context: ToolContext): Promise<ToolOutput<unknown>> {
    if (!context.schedules) return this.error('定时任务服务不可用');
    const timezone = systemTimeZone();
    try {
      const views = await context.schedules.list();
      const header = `当前本地时间 ${formatLocalDateTime(new Date(), timezone)}（${timezone}）`;
      const body = views.length > 0
        ? views.map((view) => describeView(view, timezone, context.mainAgentId)).join('\n')
        : '暂无定时任务';
      return this.success(`${header}\n${body}`, {
        timezone,
        schedules: views.map((view) => ({
          scheduleId: view.schedule.scheduleId,
          name: view.schedule.name,
          trigger: view.schedule.trigger,
          nextRunAt: view.nextRunAt,
          target: view.schedule.action.kind === 'inject' ? 'this_session' : 'new_run',
          runIfMissed: view.schedule.runIfMissed,
          enabled: view.schedule.enabled,
          suspended: view.state.suspended ?? null,
          firedAt: view.state.firedAt ?? null,
          createdByThisSession: view.schedule.createdBy.kind === 'agent'
            && view.schedule.createdBy.agentId === context.mainAgentId,
        })),
      });
    } catch (error) {
      return this.error(`列出定时任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
