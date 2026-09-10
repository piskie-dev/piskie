/**
 * thread 左栏按工作区分组的单测。
 *
 * 左栏使用「工作区 → thread（在跑 + 历史同一列表）」，所以这里的入参统一成 `ThreadRow`；
 * 合并本身的测试在 `threadRows.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { resolveTaskDescription, type SessionRow } from '../sessionRow';
import { buildThreadRows, type ThreadRow } from '../threadRows';
import {
  filterWorkspaceGroups, groupByWorkspace, moveWorkspaceGroup,
  orderWorkspaceGroups, reconcileWorkspaceOrder, workspaceLabel,
} from '../workspaceGroups';
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

describe('workspace order and search', () => {
  const groups = () => groupByWorkspace([
    row({ agentId: 'a', title: 'Sample first', workspace: '/sample/alpha', createdAt: '2026-01-03T00:00:00Z' }),
    row({ agentId: 'b', title: 'Sample second', workspace: '/sample/beta', createdAt: '2026-01-02T00:00:00Z' }),
    row({ agentId: 'd', title: 'Sample default', createdAt: '2026-01-01T00:00:00Z' }),
  ], DEFAULT_WORKSPACE);

  it('starts with default first and then preserves manual order as activity changes', () => {
    const initial = reconcileWorkspaceOrder([], groups());
    expect(initial).toEqual(['', '/sample/alpha', '/sample/beta']);
    const moved = moveWorkspaceGroup(initial, '', '/sample/beta', 'after');
    expect(moved).toEqual(['/sample/alpha', '/sample/beta', '']);
    const refreshed = [...groups()].reverse();
    expect(reconcileWorkspaceOrder(moved, refreshed)).toBe(moved);
    expect(orderWorkspaceGroups(refreshed, moved).map((group) => group.key)).toEqual(moved);
  });

  it('inserts before or after the target, including the default group', () => {
    const initial = ['', '/sample/alpha', '/sample/beta'];
    expect(moveWorkspaceGroup(initial, '/sample/beta', '', 'before')).toEqual(['/sample/beta', '', '/sample/alpha']);
    expect(moveWorkspaceGroup(initial, '/sample/beta', '', 'after')).toEqual(['', '/sample/beta', '/sample/alpha']);
    expect(moveWorkspaceGroup(initial, '', '', 'after')).toBe(initial);
  });

  it('appends new workspaces and preserves the places of temporarily missing groups', () => {
    const saved = ['/sample/beta', '', '/sample/alpha'];
    const partial = groups().filter((group) => group.key !== '/sample/beta');
    const added = groupByWorkspace([row({ agentId: 'c', workspace: '/sample/gamma' })], DEFAULT_WORKSPACE);
    const next = reconcileWorkspaceOrder(saved, [...added, ...partial]);
    expect(next).toEqual([...saved, '/sample/gamma']);
    expect(orderWorkspaceGroups([...groups(), ...added], next).map((group) => group.key)).toEqual(next);
  });

  it('keeps workspaces with identical directory names distinct', () => {
    const sameNames = groupByWorkspace([
      row({ agentId: 'a', workspace: '/sample/one/demo' }),
      row({ agentId: 'b', workspace: '/sample/two/demo' }),
    ], DEFAULT_WORKSPACE);
    const order = ['/sample/two/demo', '/sample/one/demo'];
    expect(orderWorkspaceGroups(sameNames, order).map((group) => group.key)).toEqual(order);
  });

  it('filters sorted groups without changing order and matches default group labels', () => {
    const ordered = orderWorkspaceGroups(groups(), ['/sample/beta', '', '/sample/alpha']);
    expect(filterWorkspaceGroups(ordered, ' sample ').map((group) => group.key)).toEqual(['/sample/beta', '', '/sample/alpha']);
    expect(filterWorkspaceGroups(ordered, 'SECOND')[0]?.rows.map((item) => item.agentId)).toEqual(['b']);
    expect(filterWorkspaceGroups(ordered, DEFAULT_WORKSPACE).map((group) => group.key)).toEqual(['']);
    expect(filterWorkspaceGroups(ordered, 'alpha')[0]?.rows).toHaveLength(1);
    expect(filterWorkspaceGroups(ordered, '   ')).toBe(ordered);
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
