/**
 * thread 左栏按工作区分组的单测。
 *
 * 左栏使用「工作区 → thread（在跑 + 历史同一列表）」，所以这里的入参统一成 `ThreadRow`；
 * 合并本身的测试在 `threadRows.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { resolveTaskDescription, type SessionRow } from '../sessionRow';
import { buildThreadRows, type ThreadRow } from '../threadRows';
import { groupByWorkspace, workspaceLabel } from '../workspaceGroups';
import { rawText } from '../presentationText';

const DEFAULT_WORKSPACE = '默认工作区';

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

/** 分组测试只关心 workspace / 排序键，所以直接用在跑的行构造 ThreadRow */
function row(over: Partial<SessionRow> & { agentId: string }): ThreadRow {
  return buildThreadRows({ sessions: [session(over)], history: [] })[0]!;
}

describe('workspaceLabel', () => {
  it('缺省工作区给固定标签', () => {
    expect(workspaceLabel(undefined, DEFAULT_WORKSPACE)).toBe(DEFAULT_WORKSPACE);
    expect(workspaceLabel('', DEFAULT_WORKSPACE)).toBe(DEFAULT_WORKSPACE);
  });

  it('取路径末段', () => {
    expect(workspaceLabel('/Users/me/projects/proj-a', DEFAULT_WORKSPACE)).toBe('proj-a');
  });

  it('兼容 Windows 分隔符与末尾斜杠', () => {
    expect(workspaceLabel('C:\\work\\demo\\', DEFAULT_WORKSPACE)).toBe('demo');
  });
});

describe('groupByWorkspace', () => {
  it('空输入给空数组', () => {
    expect(groupByWorkspace([], DEFAULT_WORKSPACE)).toEqual([]);
  });

  it('缺省工作区独立成组', () => {
    const groups = groupByWorkspace(
      [row({ agentId: 'a' }), row({ agentId: 'b', workspace: '/w/p' })],
      DEFAULT_WORKSPACE,
    );
    expect(groups.map((group) => group.label).sort()).toEqual(['default'.replace('default', '默认工作区'), 'p'].sort());
  });

  it('组间按组内最近活跃倒序', () => {
    const groups = groupByWorkspace([
      row({ agentId: 'old', workspace: '/w/old', createdAt: '2026-07-01T00:00:00.000Z' }),
      row({ agentId: 'new', workspace: '/w/new', createdAt: '2026-07-25T00:00:00.000Z' }),
    ], DEFAULT_WORKSPACE);
    expect(groups.map((group) => group.label)).toEqual(['new', 'old']);
  });

  it('组内沿用会话排序：executing 先于 waiting', () => {
    const groups = groupByWorkspace([
      row({ agentId: 'w', workspace: '/w/p', phase: 'waiting', status: 'waiting' }),
      row({ agentId: 'e', workspace: '/w/p', phase: 'executing', status: 'running' }),
    ], DEFAULT_WORKSPACE);
    expect(groups[0]?.rows.map((item) => item.agentId)).toEqual(['e', 'w']);
  });

  it('path 只在非缺省工作区时有值', () => {
    const groups = groupByWorkspace(
      [row({ agentId: 'a' }), row({ agentId: 'b', workspace: '/w/p' })],
      DEFAULT_WORKSPACE,
    );
    const fallback = groups.find((group) => group.label === '默认工作区');
    const named = groups.find((group) => group.label === 'p');
    expect(fallback?.path).toBeUndefined();
    expect(named?.path).toBe('/w/p');
  });
});

describe('resolveTaskDescription', () => {
  it('优先用 description（快速聊天就是用户原话）', () => {
    expect(
      resolveTaskDescription({
        agentId: 'agent-1',
        runConfig: { name: 'n', description: '抓取小红书' },
      }),
    ).toBe('抓取小红书');
  });

  it('无 description 时用 promptTemplate，超 100 字截断', () => {
    const long = 'x'.repeat(150);
    const text = resolveTaskDescription({
      agentId: 'agent-1',
      runConfig: { promptTemplate: long },
    });
    expect(text).toHaveLength(101);
    expect(text.endsWith('…')).toBe(true);
  });

  it('两者都空时退回运行名称', () => {
    expect(resolveTaskDescription({
      agentId: 'agent-1',
      runConfig: { name: '导出报表' },
    })).toBe('导出报表');
  });

  it('运行名称也没有时退回 agentId', () => {
    expect(resolveTaskDescription({ agentId: 'agent-9', runConfig: {} })).toBe('agent-9');
  });

  it('纯空白不算内容', () => {
    expect(
      resolveTaskDescription({
        agentId: 'agent-1',
        runConfig: { name: 'n', description: '   ' },
      }),
    ).toBe('n');
  });
});
