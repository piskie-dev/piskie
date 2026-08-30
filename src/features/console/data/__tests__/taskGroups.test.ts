/**
 * 任务分组的单测——旧 `task-board-groups.ts` 一行测试都没有。
 */

import { describe, expect, it } from 'vitest';

import type { TaskItem } from '../../../../../shared/types';
import { groupTaskBoardItems, taskProgress } from '../taskGroups';

function task(id: string, owner: string | null, status: TaskItem['status'] = 'pending'): TaskItem {
  return { id, subject: `任务 ${id}`, description: '', status, owner, dependsOn: [] };
}

const MAIN = 'agent-main';
const LABELS = { main: 'Main', unassigned: '未分配', historicalWorker: '历史 Worker' };

function group(
  items: readonly TaskItem[],
  workers: readonly { id: string; subject: string }[] = [],
  historicalWorkerSubjects: Readonly<Record<string, string>> = {},
) {
  return groupTaskBoardItems(items, MAIN, workers, historicalWorkerSubjects, LABELS);
}

describe('groupTaskBoardItems', () => {
  it('空清单不产出分组', () => {
    expect(group([])).toEqual([]);
  });

  it('Main 与未分配各成一组，顺序固定在前', () => {
    const groups = group([task('b', null), task('a', MAIN)]);
    expect(groups.map((group) => group.key)).toEqual(['main', 'unassigned']);
  });

  it('无对应项时不出空分组', () => {
    const groups = group([task('a', MAIN)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('main');
  });

  it('worker 分组按 items 中首次出现的 owner 顺序', () => {
    const groups = group(
      [task('a', 'w2'), task('b', 'w1'), task('c', 'w2')],
      [
        { id: 'w1', subject: '抓取' },
        { id: 'w2', subject: '登录' },
      ],
    );
    expect(groups.map((group) => group.key)).toEqual(['w2', 'w1']);
    expect(groups[0]?.label).toBe('登录');
    expect(groups[0]?.items).toHaveLength(2);
  });

  it('活跃 worker 的标题取 subject，标记为活跃', () => {
    const groups = group([task('a', 'w1')], [{ id: 'w1', subject: '抓取列表' }]);
    expect(groups[0]).toMatchObject({ label: '抓取列表', workerActive: true });
  });

  it('已销毁 worker 回落到历史标题，并标记为非活跃', () => {
    const groups = group([task('a', 'w9')], [], { w9: '历史抓取' });
    expect(groups[0]).toMatchObject({ label: '历史抓取', workerActive: false });
  });

  it('历史标题也缺失时给兜底名', () => {
    const groups = group([task('a', 'w9')]);
    expect(groups[0]?.label).toBe('历史 Worker');
  });

  it('owner 为 main 的项不会重复进 worker 分组', () => {
    const groups = group([task('a', MAIN), task('b', 'w1')]);
    expect(groups.map((group) => group.key)).toEqual(['main', 'w1']);
  });
});

describe('taskProgress', () => {
  it('统计已完成数与总数', () => {
    expect(taskProgress([task('a', null, 'completed'), task('b', null, 'in_progress')])).toEqual({
      done: 1,
      total: 2,
    });
  });

  it('空清单给 0/0', () => {
    expect(taskProgress([])).toEqual({ done: 0, total: 0 });
  });
});
