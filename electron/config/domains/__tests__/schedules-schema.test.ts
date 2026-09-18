import { describe, expect, it } from 'vitest';
import {
  schedulesReadSchema,
  schedulesStoredSchema,
  schedulesWriteSchema,
} from '../schedules.adapter.js';

const scheduleId = 'sch-2HsRtt';
const definitionSchedule = {
  name: 'Nightly digest',
  enabled: true,
  trigger: { kind: 'cron' as const, expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' },
  runIfMissed: false,
  action: { kind: 'new_run' as const, launch: { kind: 'definition' as const, definitionId: 'td-2HsRtt' } },
  createdBy: { kind: 'user' as const },
};
const inlineSchedule = {
  name: 'Check the deploy',
  enabled: true,
  trigger: { kind: 'once' as const, at: '2026-09-18T09:00:00+08:00' },
  runIfMissed: true,
  action: {
    kind: 'new_run' as const,
    prompt: 'Check whether the deploy finished.',
    launch: { kind: 'inline' as const, approvalMode: 'auto' as const, workspace: '/work/project' },
  },
  createdBy: { kind: 'agent' as const, agentId: 'agent-a' },
};

describe('Schedules Domain schema', () => {
  it('accepts every action shape on writes and rejects empty keys', () => {
    expect(schedulesWriteSchema.safeParse({
      schedules: {
        [scheduleId]: definitionSchedule,
        'sch-inline': inlineSchedule,
        'sch-inject': {
          ...definitionSchedule,
          action: { kind: 'inject', prompt: 'Look again.', agentId: 'agent-a' },
          createdBy: { kind: 'agent', agentId: 'agent-a' },
        },
      },
    }).success).toBe(true);
    expect(schedulesWriteSchema.safeParse({
      schedules: { '': definitionSchedule },
    }).success).toBe(false);
  });

  it('keeps writes strict', () => {
    expect(schedulesWriteSchema.safeParse({
      schedules: { [scheduleId]: { ...definitionSchedule, retired: true } },
    }).success).toBe(false);
    expect(schedulesWriteSchema.safeParse({
      schedules: { [scheduleId]: { ...definitionSchedule, name: 'x'.repeat(41) } },
    }).success).toBe(false);
    expect(schedulesWriteSchema.safeParse({
      schedules: { [scheduleId]: { ...definitionSchedule, trigger: { kind: 'once', at: 'tomorrow' } } },
    }).success).toBe(false);
    expect(schedulesWriteSchema.safeParse({
      schedules: {
        [scheduleId]: {
          ...definitionSchedule,
          action: { kind: 'new_run', launch: { kind: 'definition', definitionId: 'td-a' }, prompt: 'extra' },
        },
      },
    }).success).toBe(false);
    expect(schedulesWriteSchema.safeParse({
      schedules: {
        [scheduleId]: {
          ...inlineSchedule,
          action: { ...inlineSchedule.action, launch: { ...inlineSchedule.action.launch, retired: 1 } },
        },
      },
    }).success).toBe(false);
  });

  it('reads stored documents leniently and defaults the creator', () => {
    const parsed = schedulesStoredSchema.parse({
      revision: 3,
      retiredRoot: true,
      schedules: {
        [scheduleId]: {
          name: definitionSchedule.name,
          trigger: definitionSchedule.trigger,
          runIfMissed: false,
          action: definitionSchedule.action,
          createdAt: '2026-09-17T00:00:00.000Z',
          retiredField: 'ignored',
        },
        'sch-inline': {
          ...inlineSchedule,
          action: {
            ...inlineSchedule.action,
            launch: { ...inlineSchedule.action.launch, retiredLaunchSetting: true },
          },
          createdAt: '2026-09-17T00:00:00.000Z',
        },
      },
    });
    expect(parsed.schedules[scheduleId]).toMatchObject({
      enabled: true,
      createdBy: { kind: 'user' },
    });
    expect(parsed.schedules[scheduleId]).not.toHaveProperty('retiredField');
    expect(parsed.schedules['sch-inline']?.action).toMatchObject({
      launch: { kind: 'inline', approvalMode: 'auto', workspace: '/work/project' },
    });
    expect(parsed.schedules['sch-inline']?.action).not.toHaveProperty('launch.retiredLaunchSetting');

    expect(schedulesReadSchema.safeParse({
      revision: 1,
      schedules: { [scheduleId]: { ...definitionSchedule, createdAt: '2026-09-17T00:00:00.000Z' } },
    }).success).toBe(true);
    expect(schedulesStoredSchema.safeParse({
      revision: 1,
      schedules: { '   ': { ...definitionSchedule, createdAt: '2026-09-17T00:00:00.000Z' } },
    }).success).toBe(false);
  });
});
