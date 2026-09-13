import { createUuid } from '@shared/utils/identifiers.js';
/**
 * TaskBoardService - Main-owned Task Board persistence and ownership rules.
 *
 * Each Main instance owns one tasks.json. Writes are short, cross-process
 * read/replace transactions; the file is the only task business truth.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type {
  TaskBoardData,
  TaskItem,
  TaskItemStatus,
} from '../../shared/types/index.js';
import { AgentRunPaths } from './agent-run-paths.js';
const TASK_STATUSES = new Set<TaskItemStatus>(['pending', 'in_progress', 'completed']);
const BOARD_KEYS = new Set(['schemaVersion', 'taskSummary', 'items']);
const ITEM_KEYS = new Set(['id', 'subject', 'description', 'status', 'owner', 'dependsOn']);
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 160;

export interface SyncTaskBoardInput {
  mainAgentId: string;
  taskSummary?: string;
  items: TaskItem[];
  /** Active Worker IDs used to report affected work. */
  activeWorkerIds?: readonly string[];
  /** Worker IDs from this Main's persisted creation records, including stopped Workers. */
  createdWorkerIds?: readonly string[];
}

export interface AffectedWorkerTasks {
  workerId: string;
  taskIds: string[];
}

export interface SyncTaskBoardResult {
  board: TaskBoardData;
  affectedWorkers: AffectedWorkerTasks[];
}

export class TaskBoardError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'lock_timeout',
    readonly currentBoard?: TaskBoardData
  ) {
    super(message);
    this.name = 'TaskBoardError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new TaskBoardError(`${label} 包含未定义字段: ${unexpected.join(', ')}`, 'invalid');
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TaskBoardError(`${label} 必须是非空字符串`, 'invalid');
  }
  return value.trim();
}

function normalizeItem(value: unknown, index: number): TaskItem {
  if (!isRecord(value)) {
    throw new TaskBoardError(`items[${index}] 必须是对象`, 'invalid');
  }
  assertExactKeys(value, ITEM_KEYS, `items[${index}]`);

  const id = requireNonEmptyString(value.id, `items[${index}].id`);
  const subject = requireNonEmptyString(value.subject, `任务 ${id} 的 subject`);
  const description = requireNonEmptyString(value.description, `任务 ${id} 的 description`);
  if (typeof value.status !== 'string' || !TASK_STATUSES.has(value.status as TaskItemStatus)) {
    throw new TaskBoardError(
      `任务 ${id} 的 status 必须是 pending/in_progress/completed`,
      'invalid'
    );
  }
  if (
    value.owner !== null &&
    (typeof value.owner !== 'string' || value.owner.trim().length === 0)
  ) {
    throw new TaskBoardError(`任务 ${id} 的 owner 必须是 Agent ID 或 null`, 'invalid');
  }
  if (
    !Array.isArray(value.dependsOn) ||
    value.dependsOn.some((dep) => typeof dep !== 'string' || dep.trim().length === 0)
  ) {
    throw new TaskBoardError(`任务 ${id} 的 dependsOn 必须是字符串数组`, 'invalid');
  }

  const dependsOn = value.dependsOn.map((dep) => dep.trim());
  if (new Set(dependsOn).size !== dependsOn.length) {
    throw new TaskBoardError(`任务 ${id} 的 dependsOn 不能包含重复 ID`, 'invalid');
  }

  return {
    id,
    subject,
    description,
    status: value.status as TaskItemStatus,
    owner: value.owner === null ? null : value.owner.trim(),
    dependsOn,
  };
}

function normalizeItems(value: unknown): TaskItem[] {
  if (!Array.isArray(value)) {
    throw new TaskBoardError('items 必须是数组', 'invalid');
  }
  const items = value.map(normalizeItem);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new TaskBoardError(`任务 ID 重复: ${item.id}`, 'invalid');
    }
    ids.add(item.id);
  }
  return items;
}

function validateDependencies(items: TaskItem[]): void {
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    for (const dependencyId of item.dependsOn) {
      if (dependencyId === item.id) {
        throw new TaskBoardError(`任务 ${item.id} 不能依赖自身`, 'invalid');
      }
      if (!ids.has(dependencyId)) {
        throw new TaskBoardError(`任务 ${item.id} 依赖不存在的任务: ${dependencyId}`, 'invalid');
      }
    }
  }
}

function validateUnassignedItems(items: TaskItem[]): void {
  const invalid = items.find((item) => item.owner === null && item.status === 'in_progress');
  if (invalid) {
    throw new TaskBoardError(
      `任务 ${invalid.id} 未分配时不能是 in_progress；请使用 owner=null、status=pending`,
      'invalid'
    );
  }
}

export function parseTaskBoard(value: unknown): TaskBoardData {
  if (!isRecord(value)) {
    throw new TaskBoardError('Task Board 根节点必须是对象', 'invalid');
  }
  assertExactKeys(value, BOARD_KEYS, 'Task Board');
  if (value.schemaVersion !== 1) {
    throw new TaskBoardError('Task Board schemaVersion 必须为 1', 'invalid');
  }

  const taskSummary = requireNonEmptyString(value.taskSummary, 'taskSummary');
  const items = normalizeItems(value.items);
  validateDependencies(items);
  return { schemaVersion: 1, taskSummary, items };
}

function itemsEqual(left: TaskItem, right: TaskItem): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectAffectedWorkers(
  currentItems: TaskItem[],
  submittedItems: TaskItem[],
  mainAgentId: string,
  activeWorkerIds: ReadonlySet<string>
): AffectedWorkerTasks[] {
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const submittedById = new Map(submittedItems.map((item) => [item.id, item]));
  const taskIdsByWorker = new Map<string, Set<string>>();
  const ids = [...new Set([...currentById.keys(), ...submittedById.keys()])];

  const record = (item: TaskItem | undefined, id: string): void => {
    if (
      !item ||
      item.status === 'completed' ||
      item.owner === null ||
      item.owner === mainAgentId ||
      !activeWorkerIds.has(item.owner)
    )
      return;
    const taskIds = taskIdsByWorker.get(item.owner) ?? new Set<string>();
    taskIds.add(id);
    taskIdsByWorker.set(item.owner, taskIds);
  };

  for (const id of ids) {
    const current = currentById.get(id);
    const submitted = submittedById.get(id);
    if (current && submitted && itemsEqual(current, submitted)) continue;
    record(current, id);
    record(submitted, id);
  }

  return [...taskIdsByWorker].map(([workerId, taskIds]) => ({
    workerId,
    taskIds: [...taskIds],
  }));
}

export class TaskBoardService {
  private readonly paths: AgentRunPaths;

  constructor(userDataDirectory = app.getPath('userData')) {
    this.paths = new AgentRunPaths(userDataDirectory);
  }

  private getTaskBoardPath(mainAgentId: string): string {
    return this.paths.tasksPath(mainAgentId);
  }

  async readTaskBoard(mainAgentId: string): Promise<TaskBoardData | null> {
    return this.readBoardFile(this.getTaskBoardPath(mainAgentId));
  }

  async syncTaskBoard(input: SyncTaskBoardInput): Promise<SyncTaskBoardResult> {
    const submittedItems = normalizeItems(input.items);
    validateUnassignedItems(submittedItems);
    const filePath = this.getTaskBoardPath(input.mainAgentId);
    const activeWorkerIds = new Set(input.activeWorkerIds ?? []);

    const requestedSummary =
      input.taskSummary === undefined
        ? undefined
        : requireNonEmptyString(input.taskSummary, 'taskSummary');

    return this.withBoardLock(filePath, async () => {
      const current = await this.readBoardFile(filePath);
      if (!current && !requestedSummary) {
        throw new TaskBoardError('Main 首次提交 Task Board 时必须提供 taskSummary', 'invalid');
      }

      this.validateMainOwners(
        current?.items ?? [],
        submittedItems,
        input.mainAgentId,
        new Set(input.createdWorkerIds ?? []),
        current ?? undefined
      );
      const affectedWorkers = current
        ? collectAffectedWorkers(current.items, submittedItems, input.mainAgentId, activeWorkerIds)
        : [];
      validateDependencies(submittedItems);

      const board: TaskBoardData = {
        schemaVersion: 1,
        taskSummary: requestedSummary ?? current!.taskSummary,
        items: submittedItems,
      };
      await this.writeBoardAtomically(filePath, board);

      return { board, affectedWorkers };
    });
  }

  private validateMainOwners(
    currentItems: TaskItem[],
    submittedItems: TaskItem[],
    mainAgentId: string,
    createdWorkerIds: ReadonlySet<string>,
    currentBoard?: TaskBoardData
  ): void {
    const currentById = new Map(currentItems.map((item) => [item.id, item]));
    for (const item of submittedItems) {
      if (item.owner === null || item.owner === mainAgentId || createdWorkerIds.has(item.owner)) {
        continue;
      }
      if (currentById.get(item.id)?.owner === item.owner) continue;
      throw new TaskBoardError(
        `任务 ${item.id} 的 owner 不是当前 Main 或正在运行的 Worker；` +
        '尚未分配的任务请使用 owner=null、status=pending',
        'invalid',
        currentBoard
      );
    }
  }

  private async readBoardFile(filePath: string): Promise<TaskBoardData | null> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new TaskBoardError(
          `tasks.json 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
          'invalid'
        );
      }
      return parseTaskBoard(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async withBoardLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const lockPath = `${filePath}.lock`;
    let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;

    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        const candidate = await fs.open(lockPath, 'wx');
        try {
          await candidate.writeFile(
            JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
            'utf8'
          );
          lockHandle = candidate;
        } catch (error) {
          await candidate.close().catch(() => undefined);
          await fs.unlink(lockPath).catch(() => undefined);
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await fs.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(10 + attempt * 2, 75)));
      }
    }

    if (!lockHandle) {
      throw new TaskBoardError(`获取 Task Board 文件锁超时: ${filePath}`, 'lock_timeout');
    }

    try {
      return await operation();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }

  protected async beforeAtomicRename(_temporaryPath: string, _targetPath: string): Promise<void> {
    // Test seam for simulating a failure after the durable temporary write.
  }

  protected async writeBoardAtomically(filePath: string, board: TaskBoardData): Promise<void> {
    const temporaryPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${createUuid()}.tmp`
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, 'wx');
      await handle.writeFile(`${JSON.stringify(board, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.beforeAtomicRename(temporaryPath, filePath);
      await fs.rename(temporaryPath, filePath);

      const directoryHandle = await fs.open(path.dirname(filePath), 'r').catch(() => null);
      if (directoryHandle) {
        await directoryHandle.sync().catch(() => undefined);
        await directoryHandle.close().catch(() => undefined);
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

export const taskBoardService = new TaskBoardService();
