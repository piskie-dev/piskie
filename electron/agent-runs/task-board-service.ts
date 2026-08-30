import { createUuid } from '@shared/utils/identifiers.js';
/**
 * TaskBoardService - Main-owned shared Task Board persistence and ownership rules.
 *
 * Each Main instance owns one tasks.json. Writes are short, cross-process
 * read/merge/replace transactions; the file is the only task business truth.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import type {
  AssignmentTaskBoardSnapshot,
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

type ExpectedOwner = string | null;

export interface SyncTaskBoardInput {
  mainAgentId: string;
  callerAgentId: string;
  taskSummary?: string;
  items: TaskItem[];
  /** Runtime-owned Worker IDs that Main may assign new work to. */
  activeWorkerIds?: readonly string[];
  /** Assignment creation snapshot, used as a per-task compare-and-claim guard. */
  assignmentOwners?: ReadonlyMap<string, ExpectedOwner> | Readonly<Record<string, ExpectedOwner>>;
}

export interface ReadTaskBoardForMainInput {
  mainAgentId: string;
  callerAgentId: string;
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
    readonly code: 'not_found' | 'invalid' | 'conflict' | 'read_required' | 'lock_timeout',
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

function expectedOwnerMap(
  value: SyncTaskBoardInput['assignmentOwners']
): ReadonlyMap<string, ExpectedOwner> {
  if (!value) return new Map();
  return value instanceof Map ? value : new Map(Object.entries(value));
}

function ownersMatch(left: ExpectedOwner, right: ExpectedOwner): boolean {
  return left === right;
}

function boardRevision(board: TaskBoardData | null): string {
  return createHash('sha256')
    .update(board === null ? '<missing-task-board>' : JSON.stringify(board))
    .digest('hex');
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
  private readonly mainReadBaselines = new Map<string, string>();

  constructor(userDataDirectory = app.getPath('userData')) {
    this.paths = new AgentRunPaths(userDataDirectory);
  }

  private getTaskBoardPath(mainAgentId: string): string {
    return this.paths.tasksPath(mainAgentId);
  }

  async readTaskBoard(mainAgentId: string): Promise<TaskBoardData | null> {
    return this.readBoardFile(this.getTaskBoardPath(mainAgentId));
  }

  /**
   * Establishes the read baseline promised by TaskReadTool.description.
   * Ordinary UI/restoration reads intentionally do not authorize a Main write.
   */
  async readTaskBoardForMain(input: ReadTaskBoardForMainInput): Promise<TaskBoardData | null> {
    if (input.callerAgentId !== input.mainAgentId) {
      throw new TaskBoardError('只有 Main 可以建立全局 Task Board 读取基线', 'invalid');
    }
    const filePath = this.getTaskBoardPath(input.mainAgentId);
    const board = await this.readBoardFile(filePath);
    this.mainReadBaselines.set(filePath, boardRevision(board));
    return board;
  }

  async syncTaskBoard(input: SyncTaskBoardInput): Promise<SyncTaskBoardResult> {
    const submittedItems = normalizeItems(input.items);
    validateUnassignedItems(submittedItems);
    const filePath = this.getTaskBoardPath(input.mainAgentId);
    const isMain = input.callerAgentId === input.mainAgentId;
    const expectedMainRevision = isMain ? this.mainReadBaselines.get(filePath) : undefined;
    const activeWorkerIds = new Set(input.activeWorkerIds ?? []);

    if (!isMain && input.taskSummary !== undefined) {
      throw new TaskBoardError('Worker 不能修改 taskSummary', 'invalid');
    }
    const requestedSummary =
      input.taskSummary === undefined
        ? undefined
        : requireNonEmptyString(input.taskSummary, 'taskSummary');

    return this.withBoardLock(filePath, async () => {
      const current = await this.readBoardFile(filePath);
      if (!current && !isMain) {
        throw new TaskBoardError('当前 Main 尚未建立 Task Board', 'not_found');
      }
      if (!current && !requestedSummary) {
        throw new TaskBoardError('Main 首次提交 Task Board 时必须提供 taskSummary', 'invalid');
      }

      let nextItems: TaskItem[];
      let affectedWorkers: AffectedWorkerTasks[] = [];
      if (isMain) {
        if (current) this.assertMainReadBaseline(expectedMainRevision, current);
        this.validateMainOwners(
          current?.items ?? [],
          submittedItems,
          input.mainAgentId,
          activeWorkerIds,
          current ?? undefined
        );
        if (current) {
          affectedWorkers = collectAffectedWorkers(
            current.items,
            submittedItems,
            input.mainAgentId,
            activeWorkerIds
          );
        }
        nextItems = submittedItems;
      } else {
        nextItems = this.mergeWorkerScope(
          current!.items,
          submittedItems,
          input.callerAgentId,
          expectedOwnerMap(input.assignmentOwners),
          current!
        );
      }
      validateDependencies(nextItems);

      const board: TaskBoardData = {
        schemaVersion: 1,
        taskSummary: requestedSummary ?? current!.taskSummary,
        items: nextItems,
      };
      await this.writeBoardAtomically(filePath, board);
      if (isMain) this.mainReadBaselines.set(filePath, boardRevision(board));

      return { board, affectedWorkers };
    });
  }

  async createCompactSnapshot(
    mainAgentId: string,
    taskIds: string[]
  ): Promise<AssignmentTaskBoardSnapshot> {
    const board = await this.readTaskBoard(mainAgentId);
    if (!board) {
      throw new TaskBoardError('当前 Main 尚未建立 Task Board', 'not_found');
    }

    const requested = new Set(taskIds);
    const existing = new Set(board.items.map((item) => item.id));
    const missing = taskIds.filter((id) => !existing.has(id));
    if (missing.length > 0) {
      throw new TaskBoardError(
        `Task Board 中不存在以下 taskIds: ${missing.join(', ')}`,
        'not_found',
        board
      );
    }

    return {
      taskSummary: board.taskSummary,
      items: board.items.map((item) => ({
        id: item.id,
        subject: item.subject,
        status: item.status,
        owner: item.owner,
        dependsOn: [...item.dependsOn],
        assignedHere: requested.has(item.id),
      })),
    };
  }

  /** Release unfinished work owned by one Worker while retaining completed history. */
  async releaseOwnerTasks(
    mainAgentId: string,
    ownerId: string
  ): Promise<TaskBoardData | null> {
    return this.releaseOwners(mainAgentId, (owner) => owner === ownerId);
  }

  /** On Main resume every non-Main runtime owner is stale because Workers are not restored. */
  async releaseStaleWorkerTasks(
    mainAgentId: string
  ): Promise<TaskBoardData | null> {
    // A restored Main runtime must establish its own task_read baseline even when no item changes.
    this.mainReadBaselines.delete(this.getTaskBoardPath(mainAgentId));
    return this.releaseOwners(
      mainAgentId,
      (owner) => owner !== null && owner !== mainAgentId
    );
  }

  private async releaseOwners(
    mainAgentId: string,
    matches: (owner: string | null) => boolean
  ): Promise<TaskBoardData | null> {
    const filePath = this.getTaskBoardPath(mainAgentId);
    return this.withBoardLock(filePath, async () => {
      const current = await this.readBoardFile(filePath);
      if (!current) return null;

      let changed = false;
      const items = current.items.map((item) => {
        if (item.status === 'completed' || !matches(item.owner)) return item;
        changed = true;
        return { ...item, owner: null, status: 'pending' as const };
      });
      if (!changed) return current;

      const board = { ...current, items };
      await this.writeBoardAtomically(filePath, board);
      return board;
    });
  }

  /** Implements the Main task prompt's read-before-global-replace contract. */
  private assertMainReadBaseline(baseline: string | undefined, current: TaskBoardData): void {
    if (!baseline) {
      throw new TaskBoardError(
        '修改已有 Task Board 前需要先调用 task_read',
        'read_required',
        current
      );
    }
    if (baseline !== boardRevision(current)) {
      throw new TaskBoardError(
        'Task Board 在读取后已发生变化；请重新调用 task_read 后重试',
        'read_required',
        current
      );
    }
  }

  private validateMainOwners(
    currentItems: TaskItem[],
    submittedItems: TaskItem[],
    mainAgentId: string,
    activeWorkerIds: ReadonlySet<string>,
    currentBoard?: TaskBoardData
  ): void {
    const currentById = new Map(currentItems.map((item) => [item.id, item]));
    for (const item of submittedItems) {
      if (item.owner === null || item.owner === mainAgentId || activeWorkerIds.has(item.owner)) {
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

  /** Implements the Worker task prompt's owner-scoped direct replacement contract. */
  private mergeWorkerScope(
    currentItems: TaskItem[],
    submittedItems: TaskItem[],
    callerAgentId: string,
    assignmentOwners: ReadonlyMap<string, ExpectedOwner>,
    currentBoard: TaskBoardData
  ): TaskItem[] {
    const currentById = new Map(currentItems.map((item) => [item.id, item]));
    const submittedById = new Map(submittedItems.map((item) => [item.id, item]));
    const claimIds = new Set<string>();

    for (const item of submittedItems) {
      const existing = currentById.get(item.id);
      if (!existing) {
        if (assignmentOwners.has(item.id)) {
          throw new TaskBoardError(
            `Assignment 任务 ${item.id} 已从最新 Task Board 消失，不能按旧快照重新创建`,
            'conflict',
            currentBoard
          );
        }
        continue;
      }

      const callerOwnsCurrent = existing.owner === callerAgentId;
      if (callerOwnsCurrent) continue;

      const expectedOwner = assignmentOwners.get(item.id);
      const canClaim =
        assignmentOwners.has(item.id) && ownersMatch(existing.owner, expectedOwner ?? null);
      if (canClaim) {
        if (item.owner !== callerAgentId) {
          throw new TaskBoardError(
            `Worker 认领 Assignment 任务 ${item.id} 时必须把 owner 设为自身 ${callerAgentId}`,
            'invalid',
            currentBoard
          );
        }
        claimIds.add(item.id);
        continue;
      }

      if (existing.owner === null && !assignmentOwners.has(item.id)) {
        throw new TaskBoardError(
          `任务 ${item.id} 当前未分配，但未指派给 ${callerAgentId}；${callerAgentId} 无权认领、修改或使用该 task`,
          'conflict',
          currentBoard
        );
      }

      throw new TaskBoardError(
        `owner 冲突：任务 ${item.id} 当前属于 ${existing.owner ?? 'unassigned'}，${callerAgentId} 无权覆盖`,
        'conflict',
        currentBoard
      );
    }

    const merged: TaskItem[] = [];
    for (const current of currentItems) {
      const inCallerScope = current.owner === callerAgentId;
      const submitted = submittedById.get(current.id);

      if (inCallerScope) {
        if (submitted) merged.push(submitted);
        continue;
      }
      if (submitted && claimIds.has(current.id)) {
        merged.push(submitted);
      } else {
        merged.push(current);
      }
    }

    for (const submitted of submittedItems) {
      if (!currentById.has(submitted.id)) merged.push(submitted);
    }
    return merged;
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
