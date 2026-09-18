import type {
  Schedule,
  ScheduleAction,
  ScheduleFireRecord,
  ScheduleNotice,
  SchedulesSnapshot,
  ScheduleTrigger,
  ScheduleView,
} from '../types/schedules.js';

export const SCHEDULE_OPERATIONS = Object.freeze({
  list: 'schedules.list',
  create: 'schedules.create',
  update: 'schedules.update',
  delete: 'schedules.delete',
  runNow: 'schedules.run-now',
  queryHistory: 'schedules.query-history',
} as const);

export const SCHEDULE_TOPICS = Object.freeze({
  changes: 'schedules.changes',
} as const);

export interface ScheduleCreateInput {
  name: string;
  trigger: ScheduleTrigger;
  runIfMissed: boolean;
  action: ScheduleAction;
  enabled?: boolean;
}

export type ScheduleUpdateInput = Partial<
  Pick<Schedule, 'name' | 'enabled' | 'trigger' | 'runIfMissed' | 'action'>
>;

/** 闭区间 [from, to]，ISO 时刻；按记录的 firedAt 过滤。 */
export interface ScheduleHistoryQuery {
  from: string;
  to: string;
  scheduleId?: string;
}

export type ScheduleChangeEvent =
  | { kind: 'snapshot'; snapshot: SchedulesSnapshot }
  | { kind: 'notice'; notice: ScheduleNotice };

export interface ScheduleClient {
  list(): Promise<SchedulesSnapshot>;
  create(input: ScheduleCreateInput): Promise<ScheduleView>;
  update(scheduleId: string, updates: ScheduleUpdateInput): Promise<ScheduleView>;
  delete(scheduleId: string): Promise<void>;
  runNow(scheduleId: string): Promise<void>;
  queryHistory(query: ScheduleHistoryQuery): Promise<ScheduleFireRecord[]>;
  /** 订阅后先收到一次完整快照，之后每次定义或状态变化推送新快照，触发/挂起以 notice 推送。 */
  observeChanges(listener: (event: ScheduleChangeEvent) => void): () => void;
}
