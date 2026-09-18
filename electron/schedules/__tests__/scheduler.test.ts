import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentControlState } from '../../../shared/types/agent-control.js';
import type { TaskDefinition } from '../../../shared/types/index.js';
import type { Schedule, ScheduleNotice } from '../../../shared/types/schedules.js';
import { createChangeChannel } from '../../core/change-channel.js';
import { ScheduleHistoryStore } from '../schedule-history-store.js';
import { ScheduleStateStore } from '../schedule-state-store.js';
import { Scheduler } from '../scheduler.js';

const TEMPLATE: TaskDefinition = {
  definitionId: 'td-inv',
  name: '库存巡检',
  description: '',
  purpose: 'general',
  promptTemplate: '导出当日库存明细并生成摘要。',
  defaultModeId: 'plan',
  defaultApprovalMode: 'confirm',
  workspace: '/workspace/inventory',
  createdAt: '2026-09-01T00:00:00.000Z',
};

const cronSchedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  scheduleId: 'sch-daily',
  name: '每日库存巡检',
  enabled: true,
  trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
  runIfMissed: false,
  action: { kind: 'new_run', launch: { kind: 'definition', definitionId: 'td-inv' } },
  createdBy: { kind: 'user' },
  createdAt: '2026-09-18T00:00:00.000Z',
  ...overrides,
});

const control = (phase: AgentControlState['phase'], extra: Partial<AgentControlState> = {}) => (
  { agentId: 'agent-prev', phase, ...extra } as AgentControlState
);

interface Harness {
  scheduler: Scheduler;
  schedules: Schedule[];
  publish(next: Schedule[]): void;
  clock: { now: Date };
  agents: {
    startRun: ReturnType<typeof vi.fn>;
    inject: ReturnType<typeof vi.fn>;
    controlState: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  state: ScheduleStateStore;
  history: ScheduleHistoryStore;
  notices: ScheduleNotice[];
  changed: number;
  tick(at?: string): Promise<void>;
}

let directory: string;
let harness: Harness | undefined;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-'));
});

afterEach(async () => {
  harness?.scheduler.stop();
  harness = undefined;
  await fs.rm(directory, { recursive: true, force: true });
});

async function createHarness(
  schedules: Schedule[],
  options: { now?: string; templates?: TaskDefinition[]; preloadState?: unknown } = {},
): Promise<Harness> {
  const stateFile = path.join(directory, 'state.json');
  if (options.preloadState !== undefined) {
    await fs.writeFile(stateFile, JSON.stringify(options.preloadState));
  }
  const state = new ScheduleStateStore(stateFile);
  await state.load();
  const history = new ScheduleHistoryStore(path.join(directory, 'history'));
  const channel = createChangeChannel<readonly Schedule[]>();
  const clock = { now: new Date(options.now ?? '2026-09-18T01:00:30.000Z') };
  const templates = new Map((options.templates ?? [TEMPLATE]).map((entry) => [entry.definitionId, entry]));
  const agents = {
    startRun: vi.fn(async () => ({ agentId: `agent-${agents.startRun.mock.calls.length}` })),
    inject: vi.fn(async () => true),
    controlState: vi.fn((): AgentControlState | null => null),
    stop: vi.fn(async () => undefined),
  };
  const notices: ScheduleNotice[] = [];
  const current = { schedules: [...schedules] };
  const built: Harness = {
    schedules: current.schedules,
    publish: (next) => {
      current.schedules = next;
      built.schedules = next;
      channel.sink.publish(next);
    },
    clock,
    agents,
    state,
    history,
    notices,
    changed: 0,
    scheduler: undefined as unknown as Scheduler,
    tick: async (at) => {
      if (at) clock.now = new Date(at);
      built.scheduler.requestTick();
      await built.scheduler.idle();
    },
  };
  built.scheduler = new Scheduler({
    definitions: { list: () => current.schedules, changes: channel.source },
    templates: { get: (id) => templates.get(id) ?? null },
    agents,
    state,
    history,
    now: () => clock.now,
    notify: (notice) => notices.push(notice),
    onStateChanged: () => {
      built.changed += 1;
    },
  });
  harness = built;
  return built;
}

const historyOf = (h: Harness, scheduleId?: string) => h.history.query({
  from: '2026-01-01T00:00:00.000Z',
  to: '2027-01-01T00:00:00.000Z',
  ...(scheduleId ? { scheduleId } : {}),
});

describe('Scheduler', () => {
  it('fires a due cron schedule once with the template snapshot and trigger line', async () => {
    const h = await createHarness([cronSchedule()]);
    await h.tick();

    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
    const [runConfig, options] = h.agents.startRun.mock.calls[0]!;
    expect(runConfig.name).toBe('每日库存巡检');
    expect(runConfig.workspace).toBe('/workspace/inventory');
    expect(runConfig.promptTemplate).toBe(
      '此运行由定时任务「每日库存巡检」于 2026-09-18 09:00 触发，当前没有用户实时查看；完成后给出自包含的结果说明。\n\n导出当日库存明细并生成摘要。',
    );
    expect(options).toEqual({ modeId: 'plan', approvalMode: 'confirm' });
    expect(h.state.taskState('sch-daily')).toMatchObject({
      lastFiredAt: '2026-09-18T01:00:30.000Z',
      lastAgentId: 'agent-1',
      consecutiveFailures: 0,
    });
    expect(h.state.claim()).toBeUndefined();
    expect(h.notices).toEqual([
      { kind: 'started', scheduleId: 'sch-daily', name: '每日库存巡检', agentId: 'agent-1' },
    ]);
    const records = await historyOf(h);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      scheduledFor: '2026-09-18T01:00:00.000Z',
      firedAt: '2026-09-18T01:00:30.000Z',
      outcome: { kind: 'started', agentId: 'agent-1' },
    });

    await h.tick('2026-09-18T01:05:00.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
    await h.tick('2026-09-19T01:00:05.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(2);
  });

  it('does nothing before the due moment or for disabled schedules', async () => {
    const h = await createHarness(
      [cronSchedule(), cronSchedule({ scheduleId: 'sch-off', enabled: false })],
      { now: '2026-09-18T00:59:00.000Z' },
    );
    await h.tick();
    expect(h.agents.startRun).not.toHaveBeenCalled();
    await h.tick('2026-09-18T01:00:00.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
    expect(h.agents.startRun.mock.calls[0]![0].name).toBe('每日库存巡检');
  });

  it('records a missed slot as skipped when runIfMissed is off and keeps later slots', async () => {
    const h = await createHarness([cronSchedule()], { now: '2026-09-18T02:00:00.000Z' });
    await h.tick();

    expect(h.agents.startRun).not.toHaveBeenCalled();
    const records = await historyOf(h);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      scheduledFor: '2026-09-18T01:00:00.000Z',
      outcome: { kind: 'skipped', reason: 'missed' },
    });
    expect(h.state.taskState('sch-daily').lastFiredAt).toBe('2026-09-18T01:00:00.000Z');

    await h.tick('2026-09-19T01:00:10.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
  });

  it('merges several missed slots into one catch-up run when runIfMissed is on', async () => {
    const h = await createHarness(
      [cronSchedule({ trigger: { kind: 'cron', expression: '*/1 * * * *', timezone: 'UTC' }, runIfMissed: true })],
      { now: '2026-09-18T01:30:20.000Z' },
    );
    await h.tick();
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
    const records = await historyOf(h);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      scheduledFor: '2026-09-18T01:25:00.000Z',
      firedAt: '2026-09-18T01:30:20.000Z',
      outcome: { kind: 'started' },
    });
    // 锚点已推到现在，接下来只有真正的新时刻会触发。
    await h.tick('2026-09-18T01:30:50.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
    await h.tick('2026-09-18T01:31:02.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(2);
  });

  it('skips with overlap while the previous run is busy, and stops an idle one first', async () => {
    const h = await createHarness([cronSchedule()], {
      preloadState: { version: 1, tasks: { 'sch-daily': { consecutiveFailures: 0, lastAgentId: 'agent-prev', lastFiredAt: '2026-09-17T01:00:00.000Z' } } },
    });
    h.agents.controlState.mockReturnValue(control('executing'));
    await h.tick();
    expect(h.agents.startRun).not.toHaveBeenCalled();
    expect(h.agents.stop).not.toHaveBeenCalled();
    expect((await historyOf(h))[0]?.outcome).toEqual({ kind: 'skipped', reason: 'overlap' });

    h.agents.controlState.mockReturnValue(control('waiting', { pendingQuestion: {} as never }));
    await h.tick('2026-09-19T01:00:10.000Z');
    expect(h.agents.startRun).not.toHaveBeenCalled();

    h.agents.controlState.mockReturnValue(control('waiting'));
    await h.tick('2026-09-20T01:00:10.000Z');
    expect(h.agents.stop).toHaveBeenCalledWith('agent-prev');
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
    expect(h.state.taskState('sch-daily').lastAgentId).toBe('agent-1');

    h.agents.controlState.mockReturnValue(null);
    await h.tick('2026-09-21T01:00:10.000Z');
    expect(h.agents.stop).toHaveBeenCalledTimes(1);
    expect(h.agents.startRun).toHaveBeenCalledTimes(2);
  });

  it('turns a residual claim into an interrupted record without replaying the slot', async () => {
    const h = await createHarness([cronSchedule()], {
      now: '2026-09-18T01:00:40.000Z',
      preloadState: {
        version: 1,
        tasks: { 'sch-daily': { consecutiveFailures: 0 } },
        claim: {
          scheduleId: 'sch-daily',
          scheduledFor: '2026-09-18T01:00:00.000Z',
          claimedAt: '2026-09-18T01:00:03.000Z',
        },
      },
    });
    await h.scheduler.start();
    await h.scheduler.idle();

    expect(h.agents.startRun).not.toHaveBeenCalled();
    expect(h.state.claim()).toBeUndefined();
    expect(h.state.taskState('sch-daily')).toMatchObject({
      lastFiredAt: '2026-09-18T01:00:03.000Z',
      consecutiveFailures: 1,
    });
    const records = await historyOf(h);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      scheduledFor: '2026-09-18T01:00:00.000Z',
      firedAt: '2026-09-18T01:00:03.000Z',
      outcome: { kind: 'failed', stage: 'interrupted' },
    });
  });

  it('isolates a failing schedule from the others in the same tick', async () => {
    const h = await createHarness([
      cronSchedule({ scheduleId: 'sch-broken', name: '坏掉的' }),
      cronSchedule({ scheduleId: 'sch-fine', name: '正常的' }),
    ]);
    h.agents.startRun
      .mockRejectedValueOnce(new Error('未配置 AI 模型'))
      .mockResolvedValueOnce({ agentId: 'agent-fine' });
    await h.tick();

    expect(h.agents.startRun).toHaveBeenCalledTimes(2);
    expect(h.state.taskState('sch-broken')).toMatchObject({ consecutiveFailures: 1, lastFiredAt: '2026-09-18T01:00:30.000Z' });
    expect(h.state.taskState('sch-fine')).toMatchObject({ consecutiveFailures: 0, lastAgentId: 'agent-fine' });
    const broken = await historyOf(h, 'sch-broken');
    expect(broken[0]?.outcome).toEqual({ kind: 'failed', stage: 'start', message: '未配置 AI 模型' });
    expect(h.state.claim()).toBeUndefined();
  });

  it('suspends after three consecutive start failures and notifies once', async () => {
    const h = await createHarness([cronSchedule()]);
    h.agents.startRun.mockRejectedValue(new Error('模型不可用'));
    await h.tick('2026-09-18T01:00:10.000Z');
    await h.tick('2026-09-19T01:00:10.000Z');
    expect(h.state.taskState('sch-daily').suspended).toBeUndefined();
    await h.tick('2026-09-20T01:00:10.000Z');

    expect(h.state.taskState('sch-daily').suspended).toEqual({
      code: 'consecutive-failures', count: 3, message: '模型不可用',
    });
    expect(h.notices.filter((notice) => notice.kind === 'suspended')).toHaveLength(1);
    await h.tick('2026-09-21T01:00:10.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(3);

    await h.scheduler.clearSuspension('sch-daily');
    expect(h.state.taskState('sch-daily')).toEqual({
      consecutiveFailures: 0,
      lastFiredAt: '2026-09-20T01:00:10.000Z',
    });
    h.agents.startRun.mockResolvedValue({ agentId: 'agent-ok' });
    await h.tick('2026-09-22T01:00:10.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(4);
  });

  it('fires a once schedule exactly once and marks it fired', async () => {
    const once = cronSchedule({
      scheduleId: 'sch-once',
      trigger: { kind: 'once', at: '2026-09-18T01:00:00.000Z' },
    });
    const h = await createHarness([once], { now: '2026-09-18T00:30:00.000Z' });
    await h.tick();
    expect(h.agents.startRun).not.toHaveBeenCalled();
    await h.tick('2026-09-18T01:00:20.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
    expect(h.state.taskState('sch-once').firedAt).toBe('2026-09-18T01:00:20.000Z');
    await h.tick('2026-09-18T01:01:20.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
  });

  it('fails and suspends when the template no longer exists', async () => {
    const h = await createHarness([cronSchedule()], { templates: [] });
    await h.tick();
    expect(h.agents.startRun).not.toHaveBeenCalled();
    expect(h.state.taskState('sch-daily').suspended).toEqual({ code: 'template-deleted' });
    expect((await historyOf(h))[0]?.outcome).toMatchObject({ kind: 'failed', stage: 'start' });
    expect(h.notices.at(-1)).toMatchObject({ kind: 'suspended', suspension: { code: 'template-deleted' } });
  });

  it('injects into the creating session and suspends when the session is gone', async () => {
    const inject = cronSchedule({
      scheduleId: 'sch-inject',
      name: '提醒看 PR',
      trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
      action: { kind: 'inject', prompt: '看看 PR 评论有没有新回复。', agentId: 'agent-origin' },
      createdBy: { kind: 'agent', agentId: 'agent-origin' },
    });
    const h = await createHarness([inject]);
    await h.tick();
    expect(h.agents.inject).toHaveBeenCalledWith(
      'agent-origin',
      '定时任务「提醒看 PR」到时触发（计划 2026-09-18 09:00）。你创建它时留下的指令：\n\n看看 PR 评论有没有新回复。',
    );
    expect((await historyOf(h))[0]?.outcome).toEqual({ kind: 'injected', agentId: 'agent-origin' });

    h.agents.inject.mockResolvedValue(false);
    await h.tick('2026-09-19T01:00:10.000Z');
    expect(h.state.taskState('sch-inject').suspended).toEqual({ code: 'target-missing' });
    expect((await historyOf(h)).at(-1)?.outcome).toMatchObject({ kind: 'failed', stage: 'inject' });
  });

  it('runs a schedule manually without consuming its planned slot', async () => {
    const h = await createHarness([cronSchedule()], { now: '2026-09-18T00:30:00.000Z' });
    await h.scheduler.runNow('sch-daily');
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
    expect(h.state.taskState('sch-daily')).toEqual({ consecutiveFailures: 0, lastAgentId: 'agent-1' });
    const records = await historyOf(h);
    expect(records[0]).toMatchObject({ manual: true, outcome: { kind: 'started' } });

    await h.tick('2026-09-18T01:00:10.000Z');
    expect(h.agents.startRun).toHaveBeenCalledTimes(2);
    await expect(h.scheduler.runNow('sch-missing')).rejects.toThrow();
  });

  it('forgets state and history of a deleted schedule', async () => {
    const h = await createHarness([cronSchedule()]);
    await h.tick();
    expect(await historyOf(h, 'sch-daily')).toHaveLength(1);
    await h.scheduler.forget('sch-daily');
    expect(h.state.tasks()).toEqual({});
    expect(await historyOf(h, 'sch-daily')).toEqual([]);
  });

  it('re-evaluates when the definitions change', async () => {
    const h = await createHarness([], { now: '2026-09-18T01:00:30.000Z' });
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.agents.startRun).not.toHaveBeenCalled();
    h.publish([cronSchedule()]);
    await h.scheduler.idle();
    expect(h.agents.startRun).toHaveBeenCalledTimes(1);
  });
});
