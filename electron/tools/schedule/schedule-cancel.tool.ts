import { BaseTool } from '../base-tool.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { scheduleCancelSchema, type ScheduleCancelParams } from './schedule-contract.js';

export class ScheduleCancelTool extends BaseTool<ScheduleCancelParams> {
  readonly def: ToolDef<ScheduleCancelParams> = {
    name: 'schedule_cancel',
    scope: 'main',
    effects: ['agent-control'],
    schema: scheduleCancelSchema,
    description: '删除一个定时任务，之后它不再触发；已经由它启动的运行不受影响。',
  };

  async execute(params: ScheduleCancelParams, context: ToolContext): Promise<ToolOutput<unknown>> {
    if (!context.schedules) return this.error('定时任务服务不可用');
    try {
      const existing = (await context.schedules.list())
        .find((view) => view.schedule.scheduleId === params.scheduleId);
      const removed = await context.schedules.cancel(params.scheduleId);
      if (!removed) return this.error(`定时任务不存在: ${params.scheduleId}`);
      const name = existing?.schedule.name ?? params.scheduleId;
      return this.success(`已删除定时任务「${name}」（${params.scheduleId}）`, {
        scheduleId: params.scheduleId,
        name,
      });
    } catch (error) {
      return this.error(`删除定时任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
