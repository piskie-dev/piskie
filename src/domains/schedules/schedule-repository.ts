import { createStore, type StoreApi } from 'zustand/vanilla';

import type {
  ScheduleChangeEvent,
  ScheduleClient,
  ScheduleCreateInput,
  ScheduleHistoryQuery,
  ScheduleUpdateInput,
} from '@shared/electron-contracts/schedules';
import type {
  ScheduleFireRecord,
  ScheduleNotice,
  ScheduleView,
} from '@shared/types/schedules';

export type ScheduleQueryPhase = 'idle' | 'loading' | 'ready' | 'refreshing' | 'failed';

export interface ScheduleRepositorySnapshot {
  readonly phase: ScheduleQueryPhase;
  readonly items: readonly ScheduleView[];
  readonly error: string | null;
  /** 每次拿到新快照递增；页面用它决定何时重新拉触发记录。 */
  readonly revision: number;
}

export interface ScheduleRepository {
  readonly state: StoreApi<ScheduleRepositorySnapshot>;
  /** 订阅 `schedules.changes`：先到一次完整快照，之后定义或状态变化推新快照。返回取消订阅。 */
  start(): () => void;
  refresh(): Promise<void>;
  create(input: ScheduleCreateInput): Promise<ScheduleView>;
  update(scheduleId: string, updates: ScheduleUpdateInput): Promise<ScheduleView>;
  delete(scheduleId: string): Promise<void>;
  runNow(scheduleId: string): Promise<void>;
  queryHistory(query: ScheduleHistoryQuery): Promise<ScheduleFireRecord[]>;
  /** 触发成功 / 系统挂起的即时通知；不进快照，只给 toast 之类的一次性提示用。 */
  onNotice(listener: (notice: ScheduleNotice) => void): () => void;
  close(): void;
}

const EMPTY_ITEMS: readonly ScheduleView[] = Object.freeze([]);
const INITIAL_STATE: ScheduleRepositorySnapshot = Object.freeze({
  phase: 'idle',
  items: EMPTY_ITEMS,
  error: null,
  revision: 0,
});

export function createScheduleRepository(client: ScheduleClient): ScheduleRepository {
  const state = createStore<ScheduleRepositorySnapshot>(() => INITIAL_STATE);
  const noticeListeners = new Set<(notice: ScheduleNotice) => void>();
  let requestSequence = 0;
  let accepting = true;

  const accept = (items: readonly ScheduleView[]): void => {
    const current = state.getState();
    state.setState({
      phase: 'ready',
      items,
      error: null,
      revision: current.revision + 1,
    }, true);
  };

  const refresh = async (): Promise<void> => {
    if (!accepting) return;
    const request = ++requestSequence;
    const current = state.getState();
    state.setState({
      ...current,
      phase: current.phase === 'idle' ? 'loading' : 'refreshing',
      error: null,
    }, true);
    try {
      const snapshot = await client.list();
      if (!accepting || request !== requestSequence) return;
      accept(snapshot.items);
    } catch (error) {
      if (!accepting || request !== requestSequence) return;
      state.setState({
        phase: 'failed',
        items: current.items,
        error: error instanceof Error ? error.message : String(error),
        revision: current.revision,
      }, true);
    }
  };

  const onEvent = (event: ScheduleChangeEvent): void => {
    if (!accepting) return;
    if (event.kind === 'snapshot') {
      // 推送的快照就是最新事实；让还在路上的 list() 结果作废。
      requestSequence += 1;
      accept(event.snapshot.items);
      return;
    }
    for (const listener of noticeListeners) {
      try {
        listener(event.notice);
      } catch (error) {
        console.error('Schedule notice listener failed:', error);
      }
    }
  };

  const ensureAccepting = (): void => {
    if (!accepting) throw new Error('ScheduleRepository is closed');
  };

  return {
    state,
    start() {
      ensureAccepting();
      const current = state.getState();
      if (current.phase === 'idle') state.setState({ ...current, phase: 'loading' }, true);
      return client.observeChanges(onEvent);
    },
    refresh,
    async create(input) {
      ensureAccepting();
      return client.create(input);
    },
    async update(scheduleId, updates) {
      ensureAccepting();
      return client.update(scheduleId, updates);
    },
    async delete(scheduleId) {
      ensureAccepting();
      await client.delete(scheduleId);
    },
    async runNow(scheduleId) {
      ensureAccepting();
      await client.runNow(scheduleId);
    },
    async queryHistory(query) {
      ensureAccepting();
      return client.queryHistory(query);
    },
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => {
        noticeListeners.delete(listener);
      };
    },
    close() {
      if (!accepting) return;
      accepting = false;
      requestSequence += 1;
      noticeListeners.clear();
      state.setState(INITIAL_STATE, true);
    },
  };
}
