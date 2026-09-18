import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleView } from '../../../../shared/types/schedules.js';
import { formatLocalDateTime, systemTimeZone } from '../../../schedules/local-time.js';
import { ScheduleTool } from '../schedule.tool.js';
import { ScheduleListTool } from '../schedule-list.tool.js';
import { ScheduleCancelTool } from '../schedule-cancel.tool.js';
import { scheduleSchema } from '../schedule-contract.js';
import { toApiSchema } from '../../params.js';

const port = {
  create: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
};

const context = (overrides: Record<string, unknown> = {}) => ({
  agentType: 'main',
  agentSpec: 'director',
  agentId: 'main-1',
  mainAgentId: 'main-1',
  currentModel: 'provider-a::model-x',
  modes: {
    approvalMode: () => 'confirm',
    modeId: () => 'normal',
  },
  runConfig: {
    name: 'origin',
    description: 'origin',
    promptTemplate: 'origin',
    workspace: '/tmp/workspace',
    bindings: { type: 'standard', boundEnvironmentIds: ['browser-1'] },
    mcpServers: ['fs'],
  },
  schedules: port,
  ...overrides,
}) as never;

function view(partial: Partial<ScheduleView['schedule']> = {}, state: Partial<ScheduleView['state']> = {}, nextRunAt: string | null = '2026-09-18T01:00:00.000Z'): ScheduleView {
  return {
    schedule: {
      scheduleId: 'sch-1',
      name: '库存巡检',
      enabled: true,
      trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' },
      runIfMissed: false,
      action: { kind: 'inject', prompt: '检查库存', agentId: 'main-1' },
      createdBy: { kind: 'agent', agentId: 'main-1' },
      createdAt: '2026-09-17T00:00:00.000Z',
      ...partial,
    },
    state: { consecutiveFailures: 0, ...state },
    nextRunAt,
  };
}

beforeEach(() => {
  port.create.mockReset();
  port.list.mockReset();
  port.cancel.mockReset();
});

describe('scheduleSchema', () => {
  const base = { name: '巡检', prompt: '检查', target: 'new_run', runIfMissed: false };

  it('at、delaySeconds、cron 三者必须且只能提供一个', () => {
    expect(scheduleSchema.safeParse({ ...base, cron: '0 9 * * *' }).success).toBe(true);
    expect(scheduleSchema.safeParse(base).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, cron: '0 9 * * *', delaySeconds: 60 }).success).toBe(false);
  });

  it('拒绝未知字段和过短延迟', () => {
    expect(scheduleSchema.safeParse({ ...base, cron: '0 9 * * *', extra: 1 }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, delaySeconds: 30 }).success).toBe(false);
  });
});

describe('ScheduleTool', () => {
  it('描述只留开场与交接，到点动作写在 target 字段上', () => {
    const description = new ScheduleTool().def.description;
    expect(description).toContain('target=new_run 时，把新的运行当作一位刚走进房间的聪明同事来交接');
    expect(description).toContain('target=this_session 时 prompt 只需要指令本身');
    expect(description).not.toContain('到点动作');
    expect(description).not.toContain('计划获批后再创建');
    expect(description).not.toContain('「定时任务」页面');
    const target = toApiSchema(scheduleSchema).properties as Record<string, { description?: string }>;
    expect(target.target?.description).toContain('new_run');
    expect(target.target?.description).toContain('this_session');
  });

  it('Plan 模式下拒绝创建', async () => {
    const result = await new ScheduleTool().execute(
      { name: '巡检', prompt: '检查', target: 'this_session', runIfMissed: false, delaySeconds: 60 },
      context({ modes: { approvalMode: () => 'confirm', modeId: () => 'plan' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('计划尚未获批');
    expect(port.create).not.toHaveBeenCalled();
  });

  it('没有 schedules 端口时报服务不可用', async () => {
    const result = await new ScheduleTool().execute(
      { name: '巡检', prompt: '检查', target: 'this_session', runIfMissed: false, delaySeconds: 60 },
      context({ schedules: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('不可用');
  });

  it('this_session 创建注入动作，并把创建者记为本会话', async () => {
    port.create.mockImplementation(async (input, createdBy) => ({
      schedule: { ...view().schedule, ...input, createdBy },
      state: { consecutiveFailures: 0 },
      nextRunAt: input.trigger.at,
    }));
    const before = Date.now();
    const result = await new ScheduleTool().execute(
      { name: '回头检查', prompt: '看看部署结果', target: 'this_session', runIfMissed: true, delaySeconds: 600 },
      context(),
    );
    expect(result.ok).toBe(true);
    const [input, createdBy] = port.create.mock.calls[0]!;
    expect(input.action).toEqual({ kind: 'inject', prompt: '看看部署结果', agentId: 'main-1' });
    expect(input.runIfMissed).toBe(true);
    expect(input.trigger.kind).toBe('once');
    const at = new Date(input.trigger.at).getTime();
    expect(at).toBeGreaterThanOrEqual(before + 600_000);
    expect(at).toBeLessThan(before + 600_000 + 5_000);
    expect(createdBy).toEqual({ kind: 'agent', agentId: 'main-1' });
    expect(result.text).toContain('已创建定时任务 sch-1「回头检查」');
    expect(result.text).toContain('注入会话');
    expect(result.text).toContain('错过补跑');
    expect(result.text).toContain('可在「定时任务」页面查看、暂停或删除');
    expect(result.data).toMatchObject({ scheduleId: 'sch-1', target: 'this_session', runIfMissed: true, timezone: systemTimeZone() });
  });

  it('new_run 继承当前运行设置并规范化 cron 空白', async () => {
    port.create.mockImplementation(async (input) => ({
      schedule: { ...view().schedule, ...input },
      state: { consecutiveFailures: 0 },
      nextRunAt: '2026-09-18T01:00:00.000Z',
    }));
    const result = await new ScheduleTool().execute(
      { name: '每日报告', prompt: '整理昨日数据', target: 'new_run', runIfMissed: false, cron: '0   9 * *  1-5' },
      context(),
    );
    expect(result.ok).toBe(true);
    const [input] = port.create.mock.calls[0]!;
    expect(input.trigger).toEqual({ kind: 'cron', expression: '0 9 * * 1-5', timezone: systemTimeZone() });
    expect(input.action).toEqual({
      kind: 'new_run',
      prompt: '整理昨日数据',
      launch: {
        kind: 'inline',
        approvalMode: 'confirm',
        workspace: '/tmp/workspace',
        bindings: { type: 'standard', boundEnvironmentIds: ['browser-1'] },
        mcpServers: ['fs'],
        model: 'provider-a::model-x',
      },
    });
    expect(result.text).toContain('新建运行');
    expect(result.text).toContain('之后按 cron「0 9 * * 1-5」重复');
  });

  it('cron 不合法时返回具体问题', async () => {
    const result = await new ScheduleTool().execute(
      { name: '每日报告', prompt: '整理', target: 'new_run', runIfMissed: false, cron: '0 9 * *' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('5 个字段');
    expect(port.create).not.toHaveBeenCalled();
  });

  it('at 已过去时返回当前本地时间', async () => {
    const result = await new ScheduleTool().execute(
      { name: '提醒', prompt: '喝水', target: 'this_session', runIfMissed: false, at: '2020-01-01T09:00' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('2020-01-01T09:00 已经过去');
    expect(result.text).toContain(`（${systemTimeZone()}）`);
  });

  it('at 格式无法识别时报错', async () => {
    const result = await new ScheduleTool().execute(
      { name: '提醒', prompt: '喝水', target: 'this_session', runIfMissed: false, at: '明天早上' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('无法识别时刻');
  });

  it('at 在将来时按本地时区解析成 once 触发', async () => {
    port.create.mockImplementation(async (input) => ({
      schedule: { ...view().schedule, ...input },
      state: { consecutiveFailures: 0 },
      nextRunAt: input.trigger.at,
    }));
    const result = await new ScheduleTool().execute(
      { name: '提醒', prompt: '喝水', target: 'this_session', runIfMissed: false, at: '2099-01-01T09:00' },
      context(),
    );
    expect(result.ok).toBe(true);
    const [input] = port.create.mock.calls[0]!;
    expect(formatLocalDateTime(new Date(input.trigger.at), systemTimeZone())).toBe('2099-01-01 09:00');
    expect(result.text).toContain('首次触发：2099-01-01 09:00');
    expect(result.text).toContain('仅此一次');
  });

  it('后端拒绝时把原因带回', async () => {
    port.create.mockRejectedValue(new Error('任务模板不存在'));
    const result = await new ScheduleTool().execute(
      { name: '提醒', prompt: '喝水', target: 'this_session', runIfMissed: false, delaySeconds: 60 },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('任务模板不存在');
  });
});

describe('ScheduleListTool', () => {
  it('空列表也给出当前本地时间', async () => {
    port.list.mockResolvedValue([]);
    const result = await new ScheduleListTool().execute({}, context());
    expect(result.ok).toBe(true);
    expect(result.text).toContain('当前本地时间');
    expect(result.text).toContain('暂无定时任务');
  });

  it('逐行列出任务并标出本会话创建与挂起状态', async () => {
    port.list.mockResolvedValue([
      view(),
      view(
        { scheduleId: 'sch-2', name: '别人的', createdBy: { kind: 'user' }, enabled: true },
        { suspended: { code: 'consecutive-failures', count: 3, message: '模型不可用' }, consecutiveFailures: 3 },
        null,
      ),
    ]);
    const result = await new ScheduleListTool().execute({}, context());
    expect(result.ok).toBe(true);
    const lines = result.text.split('\n');
    expect(lines[1]).toContain('sch-1「库存巡检」');
    expect(lines[1]).toContain('周期 cron「0 9 * * 1-5」');
    expect(lines[1]).toContain('本会话创建');
    expect(lines[2]).toContain('sch-2「别人的」');
    expect(lines[2]).toContain('已挂起（连续 3 次启动失败：模型不可用）');
    expect(lines[2]).toContain('无下次触发');
    expect(lines[2]).not.toContain('本会话创建');
    expect(result.data).toMatchObject({
      schedules: [
        { scheduleId: 'sch-1', target: 'this_session', createdByThisSession: true },
        { scheduleId: 'sch-2', createdByThisSession: false, suspended: { code: 'consecutive-failures' } },
      ],
    });
  });
});

describe('ScheduleCancelTool', () => {
  it('删除成功时返回任务名', async () => {
    port.list.mockResolvedValue([view()]);
    port.cancel.mockResolvedValue(true);
    const result = await new ScheduleCancelTool().execute({ scheduleId: 'sch-1' }, context());
    expect(result.ok).toBe(true);
    expect(result.text).toContain('已删除定时任务「库存巡检」');
    expect(port.cancel).toHaveBeenCalledWith('sch-1');
  });

  it('任务不存在时报错', async () => {
    port.list.mockResolvedValue([]);
    port.cancel.mockResolvedValue(false);
    const result = await new ScheduleCancelTool().execute({ scheduleId: 'sch-x' }, context());
    expect(result.ok).toBe(false);
    expect(result.text).toContain('定时任务不存在');
  });
});
