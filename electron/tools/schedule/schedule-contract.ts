import { bool, int, z } from '../params.js';

const nonempty = z.string().trim().min(1);

const fields = {
  name: nonempty.max(40)
    .describe('给用户看的短标题（trim 后 1-40 字符），显示在定时任务列表和触发提示里'),
  prompt: nonempty
    .describe('到点交付的指令'),
  target: z.enum(['new_run', 'this_session'])
    .describe('到点动作。new_run：新建独立的顶层运行执行 prompt，没有用户实时看着，适合自包含的工作，尤其是周期任务；this_session：把 prompt 作为一条 system 消息送回当前会话，由你在当时的上下文里继续，适合稍后回头检查本会话已经启动的事情'),
  at: nonempty
    .describe('一次性；本地时间 ISO-8601 日期加时刻，如 2026-09-18T09:00，必须晚于现在。已过去时创建失败并返回当前本地时间'),
  delaySeconds: int(z.gte(60))
    .describe('一次性；距现在的秒数，最小 60。用于"过 N 分钟/小时"这类相对要求'),
  cron: nonempty
    .describe('周期；5 字段 cron（分 时 日 月 周），按用户本地时区解释'),
  runIfMissed: bool()
    .describe('到点时应用未运行或系统休眠，恢复后是否补跑一次；false 则跳过该次。多次错过只补一次'),
};

const TIME_FIELDS = ['at', 'delaySeconds', 'cron'] as const;

export const scheduleSchema = z.strictObject({
  name: fields.name,
  prompt: fields.prompt,
  target: fields.target,
  runIfMissed: fields.runIfMissed,
  at: fields.at.optional(),
  delaySeconds: fields.delaySeconds.optional(),
  cron: fields.cron.optional(),
}).superRefine((params, context) => {
  const given = TIME_FIELDS.filter((field) => params[field] !== undefined);
  if (given.length === 1) return;
  context.addIssue({
    code: 'custom',
    path: given.length === 0 ? ['at'] : [given[1]!],
    message: 'at、delaySeconds、cron 三者必须且只能提供一个',
  });
}).meta({
  oneOf: TIME_FIELDS.map((field) => ({
    required: ['name', 'prompt', 'target', 'runIfMissed', field],
    not: { anyOf: TIME_FIELDS.filter((other) => other !== field).map((other) => ({ required: [other] })) },
  })),
});

export type ScheduleParams = z.infer<typeof scheduleSchema>;

export const scheduleCancelSchema = z.strictObject({
  scheduleId: nonempty.describe('要删除的定时任务 ID，可从 schedule_list 或创建结果里取得'),
});

export type ScheduleCancelParams = z.infer<typeof scheduleCancelSchema>;

export const scheduleListSchema = z.object({});

export type ScheduleListParams = z.infer<typeof scheduleListSchema>;
