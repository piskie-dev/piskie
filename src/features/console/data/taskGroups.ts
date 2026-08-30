/**
 * 任务看板分组的数据侧。
 *
 * 从 `task-board-groups.ts` 搬入，两处收窄：
 * 1. worker 入参从 `ChildControlState` 收成 `{ id, subject }`——分组只需要这两个字段，
 *    不该让内容层跟着依赖控制态全量类型。
 * 2. `projectWorkerTaskBoard` 不搬：worker 的任务投影已在 `vm.ts` 的 `projectWorkerTasks`
 *    统一提供（始终从 Parent 权威看板派生）。
 *
 * 分组语义原样保留：Main → 未分配 → 各 worker（按 items 中首次出现的 owner 顺序）。
 */

import type { TaskItem } from '../../../../shared/types';

export interface TaskGroup {
  readonly key: string;
  readonly label: string;
  /** worker 是否还在（历史 worker 的分组仍要出，只是标记为非活跃） */
  readonly workerActive?: boolean;
  readonly items: readonly TaskItem[];
}

export interface WorkerLabel {
  readonly id: string;
  readonly subject: string;
}

export function groupTaskBoardItems(
  items: readonly TaskItem[],
  mainAgentId: string,
  workers: readonly WorkerLabel[],
  historicalWorkerSubjects: Readonly<Record<string, string>>,
  labels: { readonly main: string; readonly unassigned: string; readonly historicalWorker: string },
): readonly TaskGroup[] {
  const activeWorkers = new Map(workers.map((worker) => [worker.id, worker]));
  const groups: TaskGroup[] = [];

  const mainItems = items.filter((item) => item.owner === mainAgentId);
  if (mainItems.length > 0) groups.push({ key: 'main', label: labels.main, items: mainItems });

  const unassigned = items.filter((item) => item.owner === null);
  if (unassigned.length > 0) {
    groups.push({ key: 'unassigned', label: labels.unassigned, items: unassigned });
  }

  const owners = Array.from(
    new Set(
      items
        .map((item) => item.owner)
        .filter((owner): owner is string => owner !== null && owner !== mainAgentId),
    ),
  );

  for (const owner of owners) {
    const worker = activeWorkers.get(owner);
    groups.push({
      key: owner,
      label: worker?.subject || historicalWorkerSubjects[owner] || labels.historicalWorker,
      workerActive: Boolean(worker),
      items: items.filter((item) => item.owner === owner),
    });
  }

  return groups;
}

/** 完成度：用于任务清单头部的 `3/7` */
export function taskProgress(items: readonly TaskItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.status === 'completed').length, total: items.length };
}
