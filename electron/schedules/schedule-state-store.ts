import fs from 'node:fs/promises';
import type {
  ScheduleSuspension,
  ScheduleTaskState,
} from '../../shared/types/schedules.js';
import { configFileWriter, type AtomicFileWriter } from '../config/core/atomic-file-writer.js';

/** 写前声明：进程若在 startAgent 中途退出，重启后据此记一条 interrupted，不重放。 */
export interface ScheduleClaim {
  scheduleId: string;
  scheduledFor: string;
  claimedAt: string;
}

export interface SchedulesState {
  version: 1;
  tasks: Record<string, ScheduleTaskState>;
  claim?: ScheduleClaim;
}

export interface ScheduleStateLoadResult {
  /** 文件损坏时已改名保留并从空状态开始。 */
  recoveredFrom?: string;
}

/**
 * 全部任务的运行状态，单文件、单写者。
 * 启动时读一次，之后内存即真相；每次变更整体原子替换，写入按提交顺序串行。
 */
export class ScheduleStateStore {
  private state: SchedulesState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly writer: AtomicFileWriter = configFileWriter,
  ) {}

  async load(): Promise<ScheduleStateLoadResult> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        this.state = emptyState();
        return {};
      }
      throw error;
    }
    const parsed = parseState(raw);
    if (parsed) {
      this.state = parsed;
      return {};
    }
    const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
    await fs.rename(this.filePath, quarantine).catch(() => undefined);
    this.state = emptyState();
    return { recoveredFrom: quarantine };
  }

  taskState(scheduleId: string): ScheduleTaskState {
    return structuredClone(this.state.tasks[scheduleId] ?? defaultTaskState());
  }

  tasks(): Record<string, ScheduleTaskState> {
    return structuredClone(this.state.tasks);
  }

  claim(): ScheduleClaim | undefined {
    return this.state.claim ? { ...this.state.claim } : undefined;
  }

  /** 一次变更一次写：mutator 直接改内存状态，随后整体落盘。 */
  apply(mutate: (draft: SchedulesState) => void): Promise<void> {
    mutate(this.state);
    return this.persist();
  }

  updateTask(scheduleId: string, patch: Partial<ScheduleTaskState>): Promise<void> {
    return this.apply((draft) => {
      draft.tasks[scheduleId] = mergeTaskState(draft.tasks[scheduleId], patch);
    });
  }

  removeTask(scheduleId: string): Promise<void> {
    return this.apply((draft) => {
      delete draft.tasks[scheduleId];
      if (draft.claim?.scheduleId === scheduleId) delete draft.claim;
    });
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  private persist(): Promise<void> {
    const contents = `${JSON.stringify(this.state, null, 2)}\n`;
    const write = this.writeChain
      .catch(() => undefined)
      .then(() => this.writer.replace(this.filePath, contents));
    this.writeChain = write;
    return write;
  }
}

export function mergeTaskState(
  current: ScheduleTaskState | undefined,
  patch: Partial<ScheduleTaskState>,
): ScheduleTaskState {
  const merged: ScheduleTaskState = { ...(current ?? defaultTaskState()) };
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof ScheduleTaskState, ScheduleTaskState[keyof ScheduleTaskState]]
  >) {
    if (value === undefined) delete merged[key];
    else (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

function emptyState(): SchedulesState {
  return { version: 1, tasks: {} };
}

function defaultTaskState(): ScheduleTaskState {
  return { consecutiveFailures: 0 };
}

/** 宽容读取：未知字段忽略，坏掉的单条丢弃；整体不是对象或不是 JSON 才算损坏。 */
function parseState(raw: string): SchedulesState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const tasks: Record<string, ScheduleTaskState> = {};
  if (isRecord(value.tasks)) {
    for (const [scheduleId, entry] of Object.entries(value.tasks)) {
      const task = parseTaskState(entry);
      if (task) tasks[scheduleId] = task;
    }
  }
  const claim = parseClaim(value.claim);
  return { version: 1, tasks, ...(claim ? { claim } : {}) };
}

function parseTaskState(value: unknown): ScheduleTaskState | null {
  if (!isRecord(value)) return null;
  const task: ScheduleTaskState = {
    consecutiveFailures: Number.isInteger(value.consecutiveFailures)
      ? Math.max(0, value.consecutiveFailures as number)
      : 0,
  };
  if (isIsoString(value.lastFiredAt)) task.lastFiredAt = value.lastFiredAt;
  if (typeof value.lastAgentId === 'string' && value.lastAgentId) task.lastAgentId = value.lastAgentId;
  if (isIsoString(value.firedAt)) task.firedAt = value.firedAt;
  const suspended = parseSuspension(value.suspended);
  if (suspended) task.suspended = suspended;
  return task;
}

function parseSuspension(value: unknown): ScheduleSuspension | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.code) {
    case 'template-deleted':
    case 'target-missing':
      return { code: value.code };
    case 'consecutive-failures':
      return {
        code: 'consecutive-failures',
        count: Number.isInteger(value.count) ? (value.count as number) : 0,
        message: typeof value.message === 'string' ? value.message : '',
      };
    default:
      return undefined;
  }
}

function parseClaim(value: unknown): ScheduleClaim | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.scheduleId !== 'string' || !value.scheduleId) return undefined;
  if (!isIsoString(value.scheduledFor) || !isIsoString(value.claimedAt)) return undefined;
  return { scheduleId: value.scheduleId, scheduledFor: value.scheduledFor, claimedAt: value.claimedAt };
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
