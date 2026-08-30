/**
 * AccountManager 停止 barrier 测试。
 *
 * 覆盖：starting reservation 同步安装与 deferred 回调 CAS、settled 规范化、
 * 并发 stop 复用、10 秒 deadline（fake timer）、stop_failed 迟到 settle CAS、
 * 旧执行迟到回调 no-op、stop 前禁止 start、backoff 取消、destroy 并行 Abort。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';



import {
  AccountManager,
  CONNECTOR_STOP_TIMEOUT_MS,
  type AccountExecution,
} from '../account-manager.js';
import type { MessagingConnectionConfig, BotState, BotStatus } from '@shared/types/im-gateway.js';

function makeConfig(id = 'bot-1', overrides: Partial<MessagingConnectionConfig> = {}): MessagingConnectionConfig {
  return {
    id,
    channelType: 'feishu',
    name: `Bot ${id}`,
    definitionId: 'td-a',
    appId: 'app',
    appSecret: 'secret',
    ...overrides,
  };
}

/** 可外部控制 settle 的长驻 startFn（模拟 ChannelConnector.start） */
function controllableStartFn(opts: { settleOnAbort?: boolean } = {}) {
  const calls: AbortSignal[] = [];
  let resolveFn!: () => void;
  let rejectFn!: (err: Error) => void;
  const startFn = vi.fn((signal: AbortSignal) => {
    calls.push(signal);
    return new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
      if (opts.settleOnAbort) {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
      }
    });
  });
  return {
    startFn,
    calls,
    resolve: () => resolveFn(),
    reject: (err: Error) => rejectFn(err),
  };
}

function collectStatuses() {
  const events: Array<{ botId: string; status: BotStatus; error?: string }> = [];
  const onStatusChange = (botId: string, state: BotState) => {
    events.push({ botId, status: state.status, error: state.error });
  };
  return { events, onStatusChange };
}

describe('AccountManager 停止 barrier', () => {
  let manager: AccountManager;
  let events: Array<{ botId: string; status: BotStatus; error?: string }>;

  beforeEach(() => {
    const c = collectStatuses();
    events = c.events;
    manager = new AccountManager({ onStatusChange: c.onStatusChange });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── starting reservation + deferred callback CAS ──────────────

  it('reserveStarting 同步安装 starting 执行并发布 starting；期间第二次 reserve 拒绝', () => {
    const config = makeConfig();
    manager.reserveStarting(config);

    expect(manager.isConnectorQuiescent(config.id)).toBe(false);
    expect(events.at(-1)).toMatchObject({ botId: config.id, status: 'starting' });
    expect(() => manager.reserveStarting(config)).toThrow(/请先停止/);
  });

  it('starting 阶段立即 stopBot：发布 stopping、abort reservation、deferred 回调不创建 Connector', async () => {
    const config = makeConfig();
    const reservation = manager.reserveStarting(config);
    const { startFn } = controllableStartFn();

    const stopPromise = manager.stopBot(config.id);
    expect(events.at(-1)).toMatchObject({ botId: config.id, status: 'stopping' });
    expect(reservation.abortController.signal.aborted).toBe(true);

    // 模拟 setImmediate 之后才执行的 deferred start 回调
    await manager.startConnector(config, startFn, { reservation });
    expect(startFn).not.toHaveBeenCalled();

    await stopPromise;
    expect(events.at(-1)).toMatchObject({ botId: config.id, status: 'stopped' });
    expect(manager.isConnectorQuiescent(config.id)).toBe(true);
  });

  it('failExecution 清空执行后旧 reservation 回调因 CAS 不命中而 no-op', async () => {
    const config = makeConfig();
    const reservation = manager.reserveStarting(config);
    manager.failExecution(reservation, 'boom');
    expect(events.at(-1)).toMatchObject({ status: 'error', error: 'boom' });
    expect(manager.isConnectorQuiescent(config.id)).toBe(true); // 普通终态 error 即静止

    const { startFn } = controllableStartFn();
    await manager.startConnector(config, startFn, { reservation });
    expect(startFn).not.toHaveBeenCalled();
    expect(manager.isConnectorQuiescent(config.id)).toBe(true);
    expect(events.at(-1)).toMatchObject({ status: 'error' }); // 状态未被旧回调覆盖
  });

  // ── settled 规范化 + 手动停止不自动重连 ────────────────────────

  it('connector resolve 于手动停止期间：不自动重连，settle 后才发布 stopped', async () => {
    const config = makeConfig();
    const conn = controllableStartFn({ settleOnAbort: true });
    await manager.startConnector(config, conn.startFn);

    expect(events.at(-1)).toMatchObject({ status: 'running' });
    expect(manager.isConnectorQuiescent(config.id)).toBe(false);

    await manager.stopBot(config.id);
    expect(events.at(-1)).toMatchObject({ status: 'stopped' });
    expect(manager.isConnectorQuiescent(config.id)).toBe(true);
    expect(conn.startFn).toHaveBeenCalledTimes(1); // 无自动重连
  });

  it('connector reject 于手动停止期间：同样规范化为 settled，不自动重连', async () => {
    const config = makeConfig();
    const conn = controllableStartFn();
    await manager.startConnector(config, conn.startFn);

    const stopPromise = manager.stopBot(config.id);
    conn.reject(new Error('teardown error'));
    await stopPromise;

    expect(events.at(-1)).toMatchObject({ status: 'stopped' });
    expect(conn.startFn).toHaveBeenCalledTimes(1);
  });

  // ── 并发 stop 复用 ────────────────────────────────────────────

  it('两个并发 stopBot 复用同一停止等待，只发生一次 stopping 迁移', async () => {
    const config = makeConfig();
    const conn = controllableStartFn({ settleOnAbort: true });
    await manager.startConnector(config, conn.startFn);

    const p1 = manager.stopBot(config.id);
    const p2 = manager.stopBot(config.id);
    await Promise.all([p1, p2]);

    const stoppingCount = events.filter((e) => e.status === 'stopping').length;
    const stoppedCount = events.filter((e) => e.status === 'stopped').length;
    expect(stoppingCount).toBe(1);
    expect(stoppedCount).toBe(1);
    expect(manager.isConnectorQuiescent(config.id)).toBe(true);
  });

  // ── 10 秒 deadline、stop_failed、迟到 settle CAS ────────────

  it('fake timer：10 秒未 settle 抛 connector_stop_timeout、发布 stop_failed、保留执行', async () => {
    vi.useFakeTimers();
    const config = makeConfig();
    const conn = controllableStartFn(); // 不响应 abort，永不 settle
    await manager.startConnector(config, conn.startFn);

    const stopPromise = manager.stopBot(config.id);
    const captured = stopPromise.catch((err: Error) => err);

    // 9.999 秒仍在等待
    await vi.advanceTimersByTimeAsync(CONNECTOR_STOP_TIMEOUT_MS - 1);
    expect(events.at(-1)).toMatchObject({ status: 'stopping' });

    await vi.advanceTimersByTimeAsync(1);
    const err = await captured;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('connector_stop_timeout');
    expect(events.at(-1)).toMatchObject({ status: 'stop_failed', error: 'connector_stop_timeout' });
    // 错误文案无重启建议
    expect((err as Error).message).not.toMatch(/重启|restart/i);
    // 执行保留：仍不静止，禁止改绑/启动
    expect(manager.isConnectorQuiescent(config.id)).toBe(false);
    expect(() => manager.reserveStarting(config)).toThrow(/请先停止/);
  });

  it('stop_failed 后旧执行迟到 settle：CAS 清理并自动发布 stopped，此后 start 才成功', async () => {
    vi.useFakeTimers();
    const config = makeConfig();
    const conn = controllableStartFn();
    await manager.startConnector(config, conn.startFn);

    const stopPromise = manager.stopBot(config.id).catch(() => {});
    await vi.advanceTimersByTimeAsync(CONNECTOR_STOP_TIMEOUT_MS);
    await stopPromise;
    expect(events.at(-1)).toMatchObject({ status: 'stop_failed' });

    // 旧执行迟到 settle
    conn.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.at(-1)).toMatchObject({ status: 'stopped' });
    expect(manager.isConnectorQuiescent(config.id)).toBe(true);
    expect(() => manager.reserveStarting(config)).not.toThrow();
  });

  // ── 旧执行迟到回调携带 expectedExecution，CAS 不命中 no-op ────

  it('旧执行完成回调 CAS 不命中：不读取/覆盖后来执行', async () => {
    const config = makeConfig();
    const connA = controllableStartFn({ settleOnAbort: true });
    await manager.startConnector(config, connA.startFn);
    await manager.stopBot(config.id);

    const connB = controllableStartFn({ settleOnAbort: true });
    await manager.startConnector(config, connB.startFn);
    expect(events.at(-1)).toMatchObject({ status: 'running' });

    // 直接以 A 时代的过期执行对象调用私有结束回调，模拟任意时序的迟到回调
    const staleExecution = {
      config,
      abortController: new AbortController(),
      settled: Promise.resolve(),
      phase: 'connector',
      stopRequested: false,
      markSettled: () => {},
    };
    await (manager as unknown as {
      onAccountEnded(botId: string, e: unknown, err?: Error): Promise<void>;
    }).onAccountEnded(config.id, staleExecution, new Error('stale'));

    // B 不受影响：状态未变、不进入 backoff、不静止
    expect(events.at(-1)).toMatchObject({ status: 'running' });
    expect(manager.isConnectorQuiescent(config.id)).toBe(false);
    expect(connB.startFn).toHaveBeenCalledTimes(1);
  });

  // ── stop A 成功返回前 start B 一律失败 ────────────────────────

  it('stop 未完成前 start 被拒绝；barrier 完成后才允许', async () => {
    const config = makeConfig();
    const conn = controllableStartFn();
    await manager.startConnector(config, conn.startFn);

    const stopPromise = manager.stopBot(config.id);
    expect(() => manager.reserveStarting(config)).toThrow(/请先停止/);

    conn.resolve();
    await stopPromise;
    expect(() => manager.reserveStarting(config)).not.toThrow();
  });

  // ── 意外结束自动重连 + backoff 期间停止 ─────────────────────

  it('意外结束进入 backoff，fake timer 推进后用旧启动快照自动重连', async () => {
    vi.useFakeTimers();
    const config = makeConfig();
    const conn = controllableStartFn();
    await manager.startConnector(config, conn.startFn);

    conn.reject(new Error('connection lost'));
    await vi.advanceTimersByTimeAsync(0);

    // 进入 backoff：非静止，展示 starting + 重连文案
    expect(manager.isConnectorQuiescent(config.id)).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'starting' });
    expect(events.at(-1)?.error).toMatch(/Restarting/);

    // initialMs=5000 ± 10% jitter，推进 6 秒必然越过
    await vi.advanceTimersByTimeAsync(6_000);
    expect(conn.startFn).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ status: 'running' });
  });

  it('backoff 期间 stopBot：取消 sleep 并等待 backoff execution，不再调用 startFn', async () => {
    vi.useFakeTimers();
    const config = makeConfig();
    const conn = controllableStartFn();
    await manager.startConnector(config, conn.startFn);

    conn.reject(new Error('connection lost'));
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.isConnectorQuiescent(config.id)).toBe(false);

    await manager.stopBot(config.id);
    expect(events.at(-1)).toMatchObject({ status: 'stopped' });
    expect(manager.isConnectorQuiescent(config.id)).toBe(true);

    // sleep 原定时刻越过后也不会再启动
    await vi.advanceTimersByTimeAsync(360_000);
    expect(conn.startFn).toHaveBeenCalledTimes(1);
  });

  // ── 幂等 stop ──────────────────────────────────────────────────────────

  it('无执行时 stopBot 幂等发布 stopped，不抛错', async () => {
    const config = makeConfig();
    const conn = controllableStartFn({ settleOnAbort: true });
    await manager.startConnector(config, conn.startFn);
    await manager.stopBot(config.id);
    events.length = 0;

    await expect(manager.stopBot(config.id)).resolves.toBeUndefined();
    expect(events).toHaveLength(0); // 已是 stopped，不重复发布

    await expect(manager.stopBot('unknown-bot')).resolves.toBeUndefined();
  });

  // ── destroy 并行 Abort ─────────────────────────────────────────

  it('destroy 先同步 Abort 全部执行再 allSettled 等待；单个 timeout 不阻塞其他 Bot', async () => {
    vi.useFakeTimers();
    const configA = makeConfig('bot-a');
    const configB = makeConfig('bot-b');
    const connA = controllableStartFn({ settleOnAbort: true }); // abort 即 settle
    const connB = controllableStartFn();                        // 永不 settle
    await manager.startConnector(configA, connA.startFn);
    await manager.startConnector(configB, connB.startFn);

    const destroyPromise = manager.destroy();
    // Abort 在任何 await 前同步完成
    expect(connA.calls[0]!.aborted).toBe(true);
    expect(connB.calls[0]!.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(CONNECTOR_STOP_TIMEOUT_MS);
    await destroyPromise;

    // A 正常停止；B timeout 但 destroy 不提前清空 currentExecutions 伪造 settle
    expect(manager.isConnectorQuiescent(configA.id)).toBe(true);
    expect(manager.isConnectorQuiescent(configB.id)).toBe(false);
  });

  // ── AccountExecution 本地对象形状 ───────────────────────────────

  // ── 配置错误终态 ────────────────────────────────────────────────

  it('publishConfigError：静止时发布 error 终态并推送状态变更', () => {
    const config = makeConfig();
    manager.publishConfigError(config, 'task_definition_unavailable: 模板已删除');

    expect(manager.getAllBotStates().get(config.id)).toMatchObject({
      status: 'error',
      error: 'task_definition_unavailable: 模板已删除',
    });
    expect(events.at(-1)).toMatchObject({
      botId: config.id, status: 'error', error: 'task_definition_unavailable: 模板已删除',
    });
  });

  it('publishConfigError：非静止（有当前执行）时 no-op，不覆盖生命周期状态', () => {
    const config = makeConfig();
    manager.reserveStarting(config);
    const eventsBefore = events.length;

    manager.publishConfigError(config, 'task_definition_unavailable: 模板已删除');

    expect(manager.getAllBotStates().get(config.id)?.status).toBe('starting');
    expect(events.length).toBe(eventsBefore);
  });

  it('AccountExecution 是 AccountManager 本地对象，不携带 generation/runId 跨层字段', () => {
    const config = makeConfig();
    const execution: AccountExecution = manager.reserveStarting(config);
    expect(Object.keys(execution).sort()).toEqual(
      ['abortController', 'config', 'markSettled', 'phase', 'settled', 'stopRequested'].sort(),
    );
    expect(execution.phase).toBe('starting');
  });
});
