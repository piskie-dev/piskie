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
import { TaskBoardService, taskBoardService } from '../task-board-service.js';
import { ConversationStore } from '../conversation-store.js';
import type { TaskItem } from '../../../shared/types/index.js';

function task(id: string, owner: string | null, overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id, subject: `Deliver ${id}`, description: `Implement and verify ${id}.`,
    status: 'pending', owner, dependsOn: [], ...overrides,
  };
}

async function seed(items: TaskItem[], mainAgentId = 'main-a') {
  return taskBoardService.syncTaskBoard({
    mainAgentId, taskSummary: 'Sample board', items,
    createdWorkerIds: ['worker-a', 'worker-b'],
  });
}

beforeEach(async () => {
  await fs.rm(path.join(app.getPath('userData'), 'agent-runs'), { recursive: true, force: true });
});

describe('Main-owned Task Board persistence', () => {
  it('creates and directly replaces the complete board, retaining every submitted field', async () => {
    await seed([task('first', null), task('old', 'worker-a', { status: 'completed' })]);
    const items = [
      task('first', 'main-a', { status: 'completed', description: 'Verified sample result.' }),
      task('next', 'worker-b', { dependsOn: ['first'], status: 'in_progress' }),
    ];
    const updated = await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-a', taskSummary: 'Next objective', items, createdWorkerIds: ['worker-b'],
    });
    const expected = { schemaVersion: 1, taskSummary: 'Next objective', items };
    expect(updated.board).toEqual(expected);
    const file = path.join(app.getPath('userData'), 'agent-runs/main-a/tasks.json');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(expected);
    // A fresh service can continue submitting without a model read round.
    const resumed = new TaskBoardService(app.getPath('userData'));
    expect((await resumed.syncTaskBoard({ mainAgentId: 'main-a', items })).board).toEqual(expected);
  });

  it('requires a title only when first creating the board', async () => {
    await expect(taskBoardService.syncTaskBoard({ mainAgentId: 'main-a', items: [] }))
      .rejects.toThrow('Main 首次提交 Task Board 时必须提供 taskSummary');
    await seed([task('first', null)]);
    expect((await taskBoardService.syncTaskBoard({ mainAgentId: 'main-a', items: [] })).board)
      .toEqual({ schemaVersion: 1, taskSummary: 'Sample board', items: [] });
  });

  it('reports changed, transferred and deleted work by owner for active Workers only', async () => {
    const unchanged = task('unchanged', 'worker-a');
    await seed([
      unchanged, task('transfer', 'worker-a'), task('deleted', 'worker-b'),
      task('done', 'worker-b', { status: 'completed' }), task('stopped', 'worker-b'),
    ]);
    const result = await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-a', createdWorkerIds: ['worker-a', 'worker-b'], activeWorkerIds: ['worker-a', 'worker-b'],
      items: [unchanged, task('transfer', 'worker-b'), task('stopped', 'worker-b')],
    });
    expect(result.affectedWorkers).toEqual([
      { workerId: 'worker-a', taskIds: ['transfer'] },
      { workerId: 'worker-b', taskIds: ['transfer', 'deleted'] },
    ]);
    const stopped = await taskBoardService.syncTaskBoard({ mainAgentId: 'main-a', items: [] });
    expect(stopped.affectedWorkers).toEqual([]);
  });

  it('records a stopped Worker for the first time from this Main’s durable creation history', async () => {
    const store = new ConversationStore(app.getPath('userData'));
    store.append('main-a', 'main-a', { t: 'marker', ts: 1, key: 'child_created', value: { id: 'worker-finished' } });
    store.append('main-a', 'main-a', { t: 'marker', ts: 2, key: 'child_stopped', value: { id: 'worker-finished' } });
    store.append('main-b', 'main-b', { t: 'marker', ts: 3, key: 'child_created', value: { id: 'worker-other' } });
    await seed([task('delivered', null)]);
    const createdWorkerIds = new ConversationStore(app.getPath('userData')).readCreatedWorkerIds('main-a');
    expect(createdWorkerIds).toEqual(['worker-finished']);
    const result = await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-a', createdWorkerIds, activeWorkerIds: [],
      items: [task('delivered', 'worker-finished', { status: 'completed' })],
    });
    expect(result.board.items[0]).toMatchObject({ owner: 'worker-finished', status: 'completed' });
    expect(result.affectedWorkers).toEqual([]);
    await expect(taskBoardService.syncTaskBoard({
      mainAgentId: 'main-a', createdWorkerIds, items: [task('foreign', 'worker-other')],
    })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects unknown new owners while preserving existing historical responsibility', async () => {
    await expect(seed([task('unknown', 'worker-unknown')])).rejects.toMatchObject({ code: 'invalid' });
    expect(await taskBoardService.readTaskBoard('main-a')).toBeNull();
    await seed([task('history', 'worker-a', { status: 'completed' })]);
    const result = await taskBoardService.syncTaskBoard({
      mainAgentId: 'main-a', items: [task('history', 'worker-a', { status: 'completed', subject: 'Verified delivery' })],
    });
    expect(result.board.items[0]).toMatchObject({ owner: 'worker-a', subject: 'Verified delivery' });
  });

  it.each([
    ['unassigned progress', [task('a', null, { status: 'in_progress' })]],
    ['invalid status', [task('a', null, { status: 'invalid' as TaskItem['status'] })]],
    ['duplicate ids', [task('a', null), task('a', null)]],
    ['self dependency', [task('a', null, { dependsOn: ['a'] })]],
    ['missing dependency', [task('a', null, { dependsOn: ['missing'] })]],
    ['duplicate dependencies', [task('a', null), task('b', null, { dependsOn: ['a', 'a'] })]],
    ['unknown item field', [{ ...task('a', null), extra: true }]],
  ])('rejects %s without modifying the persisted board', async (_label, items) => {
    const before = await seed([task('original', 'main-a')]);
    await expect(taskBoardService.syncTaskBoard({ mainAgentId: 'main-a', items: items as TaskItem[] }))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(await taskBoardService.readTaskBoard('main-a')).toEqual(before.board);
  });

  it('retains dependency references until Main removes or updates the dependent item', async () => {
    await seed([task('before', 'main-a', { status: 'completed' }), task('after', null, { dependsOn: ['before'] })]);
    await expect(seed([task('after', null, { dependsOn: ['before'] })])).rejects.toMatchObject({ code: 'invalid' });
    expect((await seed([task('after', 'main-a', { status: 'in_progress' })])).board.items)
      .toEqual([task('after', 'main-a', { status: 'in_progress' })]);
  });

  it('serializes concurrent complete Main submissions as intact atomic versions', async () => {
    await seed([task('original', 'main-a')]);
    const versions = [[task('version-a', 'main-a')], [task('version-b', 'main-a')]];
    await Promise.all(versions.map((items) => new TaskBoardService(app.getPath('userData'))
      .syncTaskBoard({ mainAgentId: 'main-a', items })));
    expect(versions).toContainEqual((await taskBoardService.readTaskBoard('main-a'))?.items);
  });

  it('keeps the previous file intact when the atomic rename fails', async () => {
    const before = await seed([task('original', 'main-a')]);
    class FailingTaskBoardService extends TaskBoardService {
      protected override async beforeAtomicRename(): Promise<void> { throw new Error('injected rename failure'); }
    }
    await expect(new FailingTaskBoardService(app.getPath('userData')).syncTaskBoard({
      mainAgentId: 'main-a', items: [task('changed', 'main-a')],
    })).rejects.toThrow('injected rename failure');
    expect(await taskBoardService.readTaskBoard('main-a')).toEqual(before.board);
  });

  it('isolates separate Main boards', async () => {
    await seed([task('a', null)], 'main-a');
    await seed([task('b', null)], 'main-b');
    expect((await taskBoardService.readTaskBoard('main-a'))?.items).toEqual([task('a', null)]);
    expect((await taskBoardService.readTaskBoard('main-b'))?.items).toEqual([task('b', null)]);
  });
});
