import { describe, expect, it, vi } from 'vitest';

import type { ScheduleChangeEvent, ScheduleClient } from '@shared/electron-contracts/schedules';
import type { ScheduleView } from '@shared/types/schedules';
import { createScheduleRepository } from '../schedule-repository';

function view(scheduleId: string): ScheduleView {
  return {
    schedule: {
      scheduleId,
      name: `任务 ${scheduleId}`,
      enabled: true,
      trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
      runIfMissed: false,
      action: { kind: 'new_run', launch: { kind: 'definition', definitionId: 'td-1' } },
      createdBy: { kind: 'user' },
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    state: { consecutiveFailures: 0 },
    nextRunAt: '2026-09-18T01:00:00.000Z',
  };
}

function harness(overrides: Partial<ScheduleClient> = {}) {
  let listener: ((event: ScheduleChangeEvent) => void) | undefined;
  const dispose = vi.fn();
  const client: ScheduleClient = {
    list: vi.fn(async () => ({ items: [view('sch-list')] })),
    create: vi.fn(async () => view('sch-created')),
    update: vi.fn(async (scheduleId) => view(scheduleId)),
    delete: vi.fn(async () => undefined),
    runNow: vi.fn(async () => undefined),
    queryHistory: vi.fn(async () => []),
    observeChanges: vi.fn((next: (event: ScheduleChangeEvent) => void) => {
      listener = next;
      return dispose;
    }),
    ...overrides,
  };
  return {
    client,
    dispose,
    emit: (event: ScheduleChangeEvent) => listener?.(event),
  };
}

describe('ScheduleRepository', () => {
  it('订阅后由推送的快照填充状态，并逐次递增 revision', () => {
    const test = harness();
    const repository = createScheduleRepository(test.client);
    const stop = repository.start();
    expect(repository.state.getState().phase).toBe('loading');

    test.emit({ kind: 'snapshot', snapshot: { items: [view('a')] } });
    expect(repository.state.getState()).toMatchObject({ phase: 'ready', revision: 1 });
    expect(repository.state.getState().items.map((item) => item.schedule.scheduleId)).toEqual(['a']);

    test.emit({ kind: 'snapshot', snapshot: { items: [view('a'), view('b')] } });
    expect(repository.state.getState().revision).toBe(2);
    stop();
    expect(test.dispose).toHaveBeenCalledTimes(1);
  });

  it('通知只送给监听者，不改动快照', () => {
    const test = harness();
    const repository = createScheduleRepository(test.client);
    repository.start();
    const heard = vi.fn();
    const off = repository.onNotice(heard);

    test.emit({ kind: 'notice', notice: { kind: 'started', scheduleId: 'a', name: '任务 a', agentId: 'ag-1' } });
    expect(heard).toHaveBeenCalledWith({ kind: 'started', scheduleId: 'a', name: '任务 a', agentId: 'ag-1' });
    expect(repository.state.getState().revision).toBe(0);

    off();
    test.emit({ kind: 'notice', notice: { kind: 'suspended', scheduleId: 'a', name: '任务 a', suspension: { code: 'template-deleted' } } });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('推送的快照让仍在路上的 list() 结果作废', async () => {
    let resolveList!: (value: { items: ScheduleView[] }) => void;
    const list = vi.fn(() => new Promise<{ items: ScheduleView[] }>((resolve) => {
      resolveList = resolve;
    }));
    const test = harness({ list });
    const repository = createScheduleRepository(test.client);
    repository.start();

    const pending = repository.refresh();
    test.emit({ kind: 'snapshot', snapshot: { items: [view('fresh')] } });
    resolveList({ items: [view('stale')] });
    await pending;

    expect(repository.state.getState().items.map((item) => item.schedule.scheduleId)).toEqual(['fresh']);
  });

  it('list() 失败时保留原有条目并记录错误', async () => {
    const test = harness({ list: vi.fn(async () => { throw new Error('offline'); }) });
    const repository = createScheduleRepository(test.client);
    repository.start();
    test.emit({ kind: 'snapshot', snapshot: { items: [view('kept')] } });

    await repository.refresh();

    expect(repository.state.getState()).toMatchObject({ phase: 'failed', error: 'offline' });
    expect(repository.state.getState().items).toHaveLength(1);
  });

  it('写操作直接转给客户端，关闭后拒绝再用', async () => {
    const test = harness();
    const repository = createScheduleRepository(test.client);
    repository.start();

    await repository.runNow('a');
    await repository.delete('a');
    expect(test.client.runNow).toHaveBeenCalledWith('a');
    expect(test.client.delete).toHaveBeenCalledWith('a');

    repository.close();
    expect(repository.state.getState().phase).toBe('idle');
    await expect(repository.runNow('a')).rejects.toThrow('closed');
    test.emit({ kind: 'snapshot', snapshot: { items: [view('late')] } });
    expect(repository.state.getState().items).toHaveLength(0);
  });
});
