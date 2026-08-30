import { describe, expect, it } from 'vitest';

import type { HistoryRow, SessionRow } from '../sessionRow';
import { buildThreadRows, sortThreadRows } from '../threadRows';
import { rawText } from '../presentationText';

function session(over: Partial<SessionRow> & { agentId: string }): SessionRow {
  return {
    title: over.agentId,
    phase: 'executing',
    status: 'running',
    createdAt: '2026-07-29T00:00:00.000Z',
    workerCount: 0,
    model: 'anthropic::claude',
    interrupted: false,
    activity: { kind: 'idle', text: rawText('等待新的执行结果') },
    ...over,
  };
}

function record(over: Partial<HistoryRow> & { agentId: string }): HistoryRow {
  return {
    title: over.agentId,
    agentSpec: 'director',
    taskDescription: `任务 ${over.agentId}`,
    lastActiveAt: '2026-07-20T00:00:00.000Z',
    running: false,
    ...over,
  };
}

describe('buildThreadRows', () => {
  it('同一 AgentRun 的实时态与磁盘态合成一行', () => {
    const rows = buildThreadRows({
      sessions: [session({ agentId: 'agent-1' })],
      history: [record({ agentId: 'agent-1' })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.live).toBeDefined();
    expect(rows[0]?.history).toBeDefined();
  });

  it('同名任务的两次运行按 agentId 保留为两行', () => {
    const rows = buildThreadRows({
      sessions: [
        session({ agentId: 'agent-1', title: '日报模板' }),
        session({ agentId: 'agent-2', title: '日报模板' }),
      ],
      history: [],
    });

    expect(rows.map((row) => row.agentId).sort()).toEqual(['agent-1', 'agent-2']);
  });

  it('磁盘文案和工作区覆盖同一运行的实时兜底值', () => {
    const rows = buildThreadRows({
      sessions: [session({ agentId: 'agent-1', title: '模板名称' })],
      history: [record({
        agentId: 'agent-1',
        taskDescription: '抓一下竞品价格',
        workspace: '/w/project',
      })],
    });

    expect(rows[0]?.label).toBe('抓一下竞品价格');
    expect(rows[0]?.workspace).toBe('/w/project');
  });

  it('只有实时态时 description 优先于 title', () => {
    const withDescription = buildThreadRows({
      sessions: [session({ agentId: 'agent-1', title: '模板名称', description: '用户原话' })],
      history: [],
    });
    const withoutDescription = buildThreadRows({
      sessions: [session({ agentId: 'agent-2', title: '模板名称' })],
      history: [],
    });

    expect(withDescription[0]?.label).toBe('用户原话');
    expect(withoutDescription[0]?.label).toBe('模板名称');
  });

  it('lastActiveAt 取实时态和磁盘态中较新的时间', () => {
    const rows = buildThreadRows({
      sessions: [session({ agentId: 'agent-1', createdAt: '2026-07-01T00:00:00.000Z' })],
      history: [record({ agentId: 'agent-1', lastActiveAt: '2026-07-25T00:00:00.000Z' })],
    });

    expect(rows[0]?.lastActiveAt).toBe('2026-07-25T00:00:00.000Z');
  });

  it('重复的同一 agentId 只保留较新的实时投影', () => {
    const rows = buildThreadRows({
      sessions: [
        session({ agentId: 'agent-1', createdAt: '2026-07-01T00:00:00.000Z' }),
        session({ agentId: 'agent-1', createdAt: '2026-07-20T00:00:00.000Z' }),
      ],
      history: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastActiveAt).toBe('2026-07-20T00:00:00.000Z');
  });
});

describe('sortThreadRows', () => {
  it('实时运行排在纯历史之前', () => {
    const rows = buildThreadRows({
      sessions: [session({ agentId: 'live', createdAt: '2026-01-01T00:00:00.000Z' })],
      history: [record({ agentId: 'past', lastActiveAt: '2026-07-27T00:00:00.000Z' })],
    });

    expect(sortThreadRows(rows).map((row) => row.agentId)).toEqual(['live', 'past']);
  });

  it('实时运行按 phase 排序，纯历史按最近活跃倒序', () => {
    const liveRows = buildThreadRows({
      sessions: [
        session({ agentId: 'waiting', phase: 'waiting', status: 'waiting' }),
        session({ agentId: 'executing', phase: 'executing', status: 'running' }),
      ],
      history: [],
    });
    const historyRows = buildThreadRows({
      sessions: [],
      history: [
        record({ agentId: 'older', lastActiveAt: '2026-07-01T00:00:00.000Z' }),
        record({ agentId: 'newer', lastActiveAt: '2026-07-26T00:00:00.000Z' }),
      ],
    });

    expect(sortThreadRows(liveRows).map((row) => row.agentId)).toEqual([
      'executing',
      'waiting',
    ]);
    expect(sortThreadRows(historyRows).map((row) => row.agentId)).toEqual([
      'newer',
      'older',
    ]);
  });
});
