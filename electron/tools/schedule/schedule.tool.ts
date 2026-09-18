import { BaseTool } from '../base-tool.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import type { ScheduleAction, ScheduleInlineLaunch, ScheduleTrigger } from '../../../shared/types/schedules.js';
import { formatLocalDateTime, parseLocalDateTime, systemTimeZone } from '../../schedules/local-time.js';
import { checkCron, type CronProblem } from '../../schedules/next-fire.js';
import { handoffGuidance } from '../agent/handoff.js';
import { scheduleSchema, type ScheduleParams } from './schedule-contract.js';
import { describeMissedPolicy, describeTarget } from './schedule-text.js';

const OPENING = `把一段指令安排到将来某个时刻执行：用户提出周期性要求、指定时刻的提醒，或"过一会儿再检查"时使用。`;

const HANDOFF = `target=new_run 时，${handoffGuidance('运行', 'prompt', { isolated: true })}target=this_session 时 prompt 只需要指令本身，到时的你还带着这段对话。`;

const CRON_PROBLEMS: Record<CronProblem, string> = {
  'field-count': 'cron 必须是 5 个字段：分 时 日 月 周',
  syntax: 'cron 字段取值无效',
  never: 'cron 不会匹配任何时刻',
  timezone: '系统时区无法识别',
};

type TriggerResolution = { trigger: ScheduleTrigger } | { error: string };

export class ScheduleTool extends BaseTool<ScheduleParams> {
  readonly def: ToolDef<ScheduleParams> = {
    name: 'schedule',
    scope: 'main',
    effects: ['agent-control'],
    schema: scheduleSchema,
    description: `${OPENING}\n\n${HANDOFF}`,
  };

  async execute(params: ScheduleParams, context: ToolContext): Promise<ToolOutput<unknown>> {
    if (!context.schedules) return this.error('定时任务服务不可用');
    if (context.modes.modeId() === 'plan') {
      return this.error('计划尚未获批——先用 plan(create) 提交计划正文审批；获批后再创建定时任务');
    }

    const timezone = systemTimeZone();
    const now = new Date();
    const resolved = resolveTrigger(params, timezone, now);
    if ('error' in resolved) return this.error(resolved.error);

    const action: ScheduleAction = params.target === 'this_session'
      ? { kind: 'inject', prompt: params.prompt, agentId: context.mainAgentId }
      : { kind: 'new_run', prompt: params.prompt, launch: inlineLaunch(context) };

    try {
      const view = await context.schedules.create({
        name: params.name,
        trigger: resolved.trigger,
        runIfMissed: params.runIfMissed,
        action,
      }, { kind: 'agent', agentId: context.mainAgentId });
      const { schedule } = view;
      const firstRun = view.nextRunAt ?? (resolved.trigger.kind === 'once' ? resolved.trigger.at : null);
      const firstRunText = firstRun ? formatLocalDateTime(new Date(firstRun), timezone) : '待定';
      const cadence = resolved.trigger.kind === 'once'
        ? '仅此一次'
        : `之后按 cron「${resolved.trigger.expression}」重复`;
      return this.success(
        `已创建定时任务 ${schedule.scheduleId}「${schedule.name}」。\n`
        + `首次触发：${firstRunText}（${timezone}），${cadence}。目标：${describeTarget(schedule)}。${describeMissedPolicy(schedule)}。\n`
        + '可在「定时任务」页面查看、暂停或删除。',
        {
          scheduleId: schedule.scheduleId,
          nextRunAt: view.nextRunAt,
          timezone,
          target: params.target,
          runIfMissed: schedule.runIfMissed,
        },
      );
    } catch (error) {
      return this.error(`创建定时任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function resolveTrigger(params: ScheduleParams, timezone: string, now: Date): TriggerResolution {
  if (params.at !== undefined) {
    const at = parseLocalDateTime(params.at, timezone);
    if (!at) return { error: `无法识别时刻「${params.at}」；请用 YYYY-MM-DDTHH:mm 这样的本地时间` };
    if (at.getTime() <= now.getTime()) {
      return { error: `${params.at} 已经过去。当前本地时间 ${formatLocalDateTime(now, timezone)}（${timezone}）。` };
    }
    return { trigger: { kind: 'once', at: at.toISOString() } };
  }
  if (params.delaySeconds !== undefined) {
    const at = new Date(now.getTime() + params.delaySeconds * 1000);
    return { trigger: { kind: 'once', at: at.toISOString() } };
  }
  const expression = (params.cron ?? '').trim().split(/\s+/).join(' ');
  const problem = checkCron(expression, timezone);
  if (problem) return { error: `${CRON_PROBLEMS[problem]}：「${params.cron}」` };
  return { trigger: { kind: 'cron', expression, timezone } };
}

/** 与 agent_run 取同一组运行设置：新运行像创建者一样工作，只是不知道这段对话。 */
function inlineLaunch(context: ToolContext): ScheduleInlineLaunch {
  const { runConfig } = context;
  const launch: ScheduleInlineLaunch = {
    kind: 'inline',
    approvalMode: context.modes.approvalMode(),
  };
  if (runConfig.workspace) launch.workspace = runConfig.workspace;
  if (runConfig.bindings) launch.bindings = runConfig.bindings;
  if (runConfig.advancedSettings) launch.advancedSettings = runConfig.advancedSettings;
  if (runConfig.mcpServers) launch.mcpServers = [...runConfig.mcpServers];
  if (context.currentModel) launch.model = context.currentModel;
  return launch;
}
