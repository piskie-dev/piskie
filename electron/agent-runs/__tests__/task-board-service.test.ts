import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const root = mkdtempSync(nodePath.join(os.tmpdir(), 'task-service-test-'));
  return { app: { getPath: () => root, getAppPath: () => root } };
});

import { app } from 'electron';
import {
  TaskBoardError,
  TaskBoardService,
  taskBoardService,
} from '../task-board-service.js';
import type { TaskItem } from '../../../shared/types/index.js';

function task(
  id: string,
  owner: string | null,
  overrides: Partial<TaskItem> = {},
): TaskItem {
  return {
    id,
    subject: `交付 ${id}`,
    description: `完成 ${id} 的实现并验证结果。`,
    status: 'pending',
    owner,
    dependsOn: [],
    ...overrides,
  };
}

async function seed(label: string, items: TaskItem[], mainAgentId = 'main-1') {
  const activeWorkerIds = [...new Set(items
    .map((item) => item.owner)
    .filter((owner): owner is string => owner !== null && owner !== mainAgentId))];
  return taskBoardService.syncTaskBoard({
    mainAgentId,
    callerAgentId: mainAgentId,
    taskSummary: `看板 ${label}`,
    items,
    activeWorkerIds,
  });
}

beforeEach(async () => {
  await fs.rm(path.join(app.getPath('userData'), 'agent-runs'), {
    recursive: true,
    force: true,
  });
});

describe('TaskBoardService shared Task Board', () => {
  it('Main 首次完整提交只生成合法 tasks.json，并忽略同目录旧文件', async () => {
    const directory = path.join(app.getPath('userData'), 'agent-runs', 'main-1');
    await fs.mkdir(directory, { recursive: true });
    const legacyPath = path.join(directory, 'tasks.md');
    await fs.writeFile(legacyPath, 'legacy sentinel', 'utf8');

    await seed('flow-json', [task('storage', null), task('ui', 'main-1')]);

    const filePath = path.join(directory, 'tasks.json');
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(raw).toEqual({
      schemaVersion: 1,
      taskSummary: '看板 flow-json',
      items: [task('storage', null), task('ui', 'main-1')],
    });
    expect(await fs.readFile(legacyPath, 'utf8')).toBe('legacy sentinel');
  });

  it('Worker A/B 并发完整同步不同 owner 时两个修改都保留', async () => {
    await seed('flow-parallel', [task('a', 'worker-a'), task('b', 'worker-b')]);

    await Promise.all([
      taskBoardService.syncTaskBoard({
        mainAgentId: 'main-1', callerAgentId: 'worker-a',
        items: [task('a', 'worker-a', { status: 'completed', subject: 'A 已交付' })],
      }),
      taskBoardService.syncTaskBoard({
        mainAgentId: 'main-1', callerAgentId: 'worker-b',
        items: [task('b', 'worker-b', { status: 'in_progress', subject: 'B 正在实现' })],
      }),
    ]);

    const board = await taskBoardService.readTaskBoard('main-1');
    expect(board?.items).toEqual([
      task('a', 'worker-a', { status: 'completed', subject: 'A 已交付' }),
      task('b', 'worker-b', { status: 'in_progress', subject: 'B 正在实现' }),
    ]);
  });

  it('两个 Worker 同时认领同一任务时只有一个成功', async () => {
    await seed('flow-claim', [task('claim-me', null)]);
    const claim = (worker: string) => taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1',
      callerAgentId: worker,
      assignmentOwners: new Map([['claim-me', null]]),
      items: [task('claim-me', worker, { status: 'in_progress' })],
    });

    const results = await Promise.allSettled([claim('worker-a'), claim('worker-b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(TaskBoardError);
    expect((rejected?.reason as TaskBoardError).code).toBe('conflict');

    const board = await taskBoardService.readTaskBoard('main-1');
    expect(['worker-a', 'worker-b']).toContain(board?.items[0]?.owner);
  });

  it('Worker 不能覆盖其他 owner，但可保留 ID 修改自有标题且不丢其他自有项', async () => {
    await seed('flow-owner', [
      task('mine-1', 'worker-a'),
      task('mine-2', 'worker-a'),
      task('theirs', 'worker-b'),
    ]);

    await expect(taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'worker-a',
      items: [task('theirs', 'worker-a', { subject: '越权标题' })],
    })).rejects.toMatchObject({ code: 'conflict' });

    await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'worker-a',
      items: [
        task('mine-1', 'worker-a', { subject: '更准确的交付标题' }),
        task('mine-2', 'worker-a'),
      ],
    });
    const board = await taskBoardService.readTaskBoard('main-1');
    expect(board?.items.map((item) => [item.id, item.subject])).toEqual([
      ['mine-1', '更准确的交付标题'],
      ['mine-2', '交付 mine-2'],
      ['theirs', '交付 theirs'],
    ]);
  });

  it('Main 修改已有看板必须先读，读取后 items 全局替换且成功写入刷新基线', async () => {
    const userData = path.join(app.getPath('userData'), 'read-before-write');
    const writer = new TaskBoardService(userData);
    const main = new TaskBoardService(userData);
    await writer.syncTaskBoard({
      mainAgentId: 'main', callerAgentId: 'main', taskSummary: '旧目标',
      items: [task('a', 'main'), task('b', 'worker-old', { status: 'completed' })],
      activeWorkerIds: ['worker-old'],
    });

    await expect(main.syncTaskBoard({
      mainAgentId: 'main', callerAgentId: 'main', taskSummary: '新目标',
      items: [task('c', 'main')],
    })).rejects.toMatchObject({ code: 'read_required' });

    expect((await main.readTaskBoardForMain({
      mainAgentId: 'main', callerAgentId: 'main',
    }))?.items.map((item) => item.id)).toEqual(['a', 'b']);

    await main.syncTaskBoard({
      mainAgentId: 'main', callerAgentId: 'main', taskSummary: '新目标',
      items: [task('c', 'main')],
    });
    await main.syncTaskBoard({
      mainAgentId: 'main', callerAgentId: 'main',
      items: [task('c', 'main', { subject: '修改后的 C' }), task('d', null)],
    });

    expect(await main.readTaskBoard('main')).toMatchObject({
      taskSummary: '新目标',
      items: [
        { id: 'c', subject: '修改后的 C' },
        { id: 'd' },
      ],
    });
  });

  it('Worker 更新使 Main 读取基线失效，重新读取后可保留最新事实继续写入', async () => {
    await seed('flow-main-stale', [
      task('main-task', 'main-1'),
      task('worker-task', 'worker-a'),
    ]);
    await taskBoardService.readTaskBoardForMain({
      mainAgentId: 'main-1', callerAgentId: 'main-1',
    });

    await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'worker-a',
      items: [task('worker-task', 'worker-a', { status: 'in_progress', subject: 'Worker 最新事实' })],
    });
    await expect(taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'main-1',
      items: [
        task('main-task', 'main-1', { status: 'completed' }),
        task('worker-task', 'worker-a'),
      ],
    })).rejects.toMatchObject({ code: 'read_required' });

    const latest = await taskBoardService.readTaskBoardForMain({
      mainAgentId: 'main-1', callerAgentId: 'main-1',
    });
    await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'main-1',
      items: [
        task('main-task', 'main-1', { status: 'completed' }),
        latest!.items.find((item) => item.id === 'worker-task')!,
      ],
    });
    expect((await taskBoardService.readTaskBoard('main-1'))?.items[1]).toMatchObject({
      subject: 'Worker 最新事实',
      status: 'in_progress',
    });
  });

  it('Main 可修改所有任务，并返回仍在运行的受影响 Worker', async () => {
    await seed('flow-main-worker-guard', [
      task('main-task', 'main-1'),
      task('worker-open', 'worker-a', { status: 'in_progress' }),
      task('worker-done', 'worker-old', { status: 'completed' }),
    ]);

    const changed = await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'main-1',
      activeWorkerIds: ['worker-a'],
      items: [
        task('main-task', 'main-1', { status: 'completed' }),
        task('worker-open', 'worker-a', { status: 'completed' }),
      ],
    });
    expect(changed.affectedWorkers).toEqual([{ workerId: 'worker-a', taskIds: ['worker-open'] }]);
    expect(changed.board.items.map((item) => item.id)).toEqual(['main-task', 'worker-open']);

    const removedCompleted = await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'main-1',
      items: [task('main-task', 'main-1', { status: 'completed' })],
    });
    expect(removedCompleted.affectedWorkers).toEqual([]);
    expect((await taskBoardService.readTaskBoard('main-1'))?.items.map((item) => item.id))
      .toEqual(['main-task']);
  });

  it('Main 拒绝新引入未知 owner，但允许原样保留历史 owner', async () => {
    await expect(taskBoardService.syncTaskBoard({
      mainAgentId: 'main-owner-guard',
      callerAgentId: 'main-owner-guard',
      taskSummary: '非法 owner',
      items: [task('fake', 'pending-controls-worker')],
      activeWorkerIds: [],
    })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('owner 不是当前 Main 或正在运行的 Worker'),
    });
    expect(await taskBoardService.readTaskBoard('main-owner-guard')).toBeNull();

    await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-history',
      callerAgentId: 'main-history',
      taskSummary: '历史 owner',
      items: [task('done', 'worker-old', { status: 'completed' })],
      activeWorkerIds: ['worker-old'],
    });
    const preserved = await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-history',
      callerAgentId: 'main-history',
      items: [task('done', 'worker-old', { status: 'completed', subject: '保留历史归属' })],
      activeWorkerIds: [],
    });
    expect(preserved.board.items[0]).toMatchObject({
      owner: 'worker-old',
      subject: '保留历史归属',
    });
  });

  it('未分配任务不能标记为 in_progress', async () => {
    await expect(taskBoardService.syncTaskBoard({
      mainAgentId: 'main-unassigned-progress',
      callerAgentId: 'main-unassigned-progress',
      taskSummary: '非法状态',
      items: [task('unassigned', null, { status: 'in_progress' })],
    })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('owner=null、status=pending'),
    });
    expect(await taskBoardService.readTaskBoard('main-unassigned-progress')).toBeNull();
  });

  it('同一读取基线上的并发 Main 写入只有一个成功', async () => {
    await seed('flow-main-parallel', [task('a', 'main-1')]);
    const write = (subject: string) => taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'main-1',
      items: [task('a', 'main-1', { subject })],
    });

    const results = await Promise.allSettled([write('版本一'), write('版本二')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'read_required' });
  });

  it('完整列表自然表达新增、删除、拆分、改写与转交', async () => {
    await seed('flow-replace', [task('original', 'worker-a'), task('remove-me', 'worker-a')]);
    await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'worker-a',
      items: [
        task('original', 'main-1', { subject: '转交整合', status: 'pending' }),
        task('worker-a-child', 'worker-a', { dependsOn: ['original'] }),
      ],
    });
    const board = await taskBoardService.readTaskBoard('main-1');
    expect(board?.items.map((item) => [item.id, item.owner])).toEqual([
      ['original', 'main-1'],
      ['worker-a-child', 'worker-a'],
    ]);
  });

  it('拒绝重复 ID、self/dangling dependsOn 和旧字段', async () => {
    await expect(seed('flow-self', [task('a', null, { dependsOn: ['a'] })]))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(seed('flow-dangling', [task('a', null, { dependsOn: ['missing'] })]))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(seed('flow-duplicate', [task('a', null), task('a', null)]))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(seed('flow-legacy', [{ ...task('a', null), result: 'legacy' } as TaskItem]))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('紧凑快照包含全局任务与 assignedHere，但不含 description/schemaVersion', async () => {
    await seed('flow-snapshot', [task('a', null), task('b', 'worker-b', { dependsOn: ['a'] })]);
    const snapshot = await taskBoardService.createCompactSnapshot('main-1', ['b']);
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.map((item) => item.assignedHere)).toEqual([false, true]);
    expect(JSON.stringify(snapshot)).not.toContain('description');
    expect(JSON.stringify(snapshot)).not.toContain('schemaVersion');
    await expect(taskBoardService.createCompactSnapshot('main-1', ['x', 'y']))
      .rejects.toThrow('x, y');
  });

  it('临时写完成后失败不会破坏旧文件', async () => {
    const userData = path.join(app.getPath('userData'), 'atomic-agent-runs');
    const stable = new TaskBoardService(userData);
    await stable.syncTaskBoard({
      mainAgentId: 'main', callerAgentId: 'main', taskSummary: '原看板',
      items: [task('a', 'main')],
    });

    class FailingTaskBoardService extends TaskBoardService {
      protected override async beforeAtomicRename(): Promise<void> {
        throw new Error('injected rename failure');
      }
    }
    const failing = new FailingTaskBoardService(userData);
    await failing.readTaskBoardForMain({
      mainAgentId: 'main', callerAgentId: 'main',
    });
    await expect(failing.syncTaskBoard({
      mainAgentId: 'main', callerAgentId: 'main', taskSummary: '新看板',
      items: [task('a', 'main', { subject: '不应落盘' })],
    })).rejects.toThrow('injected rename failure');

    expect(await stable.readTaskBoard('main')).toMatchObject({
      taskSummary: '原看板',
      items: [{ subject: '交付 a' }],
    });
  });

  it('Worker 销毁/恢复只退回未完成任务，completed 保留历史 owner；多个 Main 隔离', async () => {
    await seed('flow-release', [
      task('open', 'worker-a', { status: 'in_progress' }),
      task('done', 'worker-a', { status: 'completed' }),
    ]);
    const released = await taskBoardService.releaseOwnerTasks('main-1', 'worker-a');
    expect(released?.items.map((item) => [item.id, item.owner, item.status])).toEqual([
      ['open', null, 'pending'],
      ['done', 'worker-a', 'completed'],
    ]);

    await seed('same-flow', [task('a', null)], 'main-a');
    await seed('same-flow', [task('b', null)], 'main-b');
    expect((await taskBoardService.readTaskBoard('main-a'))?.items[0]?.id).toBe('a');
    expect((await taskBoardService.readTaskBoard('main-b'))?.items[0]?.id).toBe('b');
  });

  it('Main resume 退回所有失效 Worker 的未完成任务', async () => {
    await seed('flow-resume-release', [
      task('worker-a-open', 'worker-a', { status: 'in_progress' }),
      task('worker-b-open', 'worker-b'),
      task('worker-b-done', 'worker-b', { status: 'completed' }),
      task('main-open', 'main-1', { status: 'in_progress' }),
      task('free', null),
    ]);

    const board = await taskBoardService.releaseStaleWorkerTasks('main-1');
    expect(board?.items.map((item) => [item.id, item.owner, item.status])).toEqual([
      ['worker-a-open', null, 'pending'],
      ['worker-b-open', null, 'pending'],
      ['worker-b-done', 'worker-b', 'completed'],
      ['main-open', 'main-1', 'in_progress'],
      ['free', null, 'pending'],
    ]);
    await expect(taskBoardService.syncTaskBoard({
      mainAgentId: 'main-1', callerAgentId: 'main-1',
      items: board!.items,
    })).rejects.toMatchObject({ code: 'read_required' });
  });
});
