/**
 * BrowserHandle 生命周期契约（直接测试 registerHandle 接缝）：
 * (a) 成品阶段挂死 → terminate 硬关经 destroyInstance settle；失败 = settlement reject、
 *     条目保留（半死边界可见）、同一 rejected settlement 可反复消费；
 * (b) 创建阶段被 terminate → 消费方 ready reject（getOrCreate settle）、迟到成品交 terminate 链关闭；
 * 创建超时也经 handle settle；ready 失败清理带身份检查，避免误删替换后的 handle。
 * 本文件直测句柄边界，stopAgent 的端到端 Service 路径由生命周期测试覆盖。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserManager } from '../browser-manager.js';

type AnyBM = {
  instances: Map<string, {
    id: string;
    ready: Promise<unknown>;
    terminate(reason: string): Promise<void>;
    getReady(): unknown;
  }>;
  registerHandle(
    browserId: string,
    create: () => Promise<unknown>,
  ): AnyBM['instances'] extends Map<string, infer H> ? H : never;
  destroyInstance(browserId: string, instance: unknown): Promise<void>;
};

const BM = BrowserManager as unknown as AnyBM;
const originalDestroyInstance = BM.destroyInstance;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeInstance(id: string): unknown {
  return { id, lastUsedAt: new Date() };
}

async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

let destroySpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  BM.instances.clear();
  destroySpy = vi.fn().mockResolvedValue(undefined);
  BM.destroyInstance = destroySpy as unknown as AnyBM['destroyInstance'];
});

afterEach(() => {
  vi.useRealTimers();
  BM.instances.clear();
});

afterAll(() => {
  BM.destroyInstance = originalDestroyInstance;
});

describe('BrowserHandle 六契约', () => {
  it('登记同步入表即取得所有权；创建中 getReady() 不把 creating 当 ready', async () => {
    const create = deferred<unknown>();
    const handle = BM.registerHandle('b1', () => create.promise);

    expect(BM.instances.get('b1')).toBe(handle);   // 第一个 await 前边界已可见
    expect(handle.getReady()).toBeUndefined();     // 存在 ≠ 可用

    const instance = fakeInstance('b1');
    create.resolve(instance);
    await expect(handle.ready).resolves.toBe(instance);
    expect(handle.getReady()).toBe(instance);
  });

  it('terminate 幂等——创建后反复调用返回同一 settlement，destroyInstance 恰好一次，settle 后条目删除', async () => {
    const instance = fakeInstance('b1');
    const handle = BM.registerHandle('b1', () => Promise.resolve(instance));
    await handle.ready;

    const s1 = handle.terminate('stop');
    const s2 = handle.terminate('stop again');
    expect(s1).toBe(s2);
    expect(handle.getReady()).toBeUndefined();   // terminate 后成品不再视为可用。

    await s1;
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledWith('b1', instance);
    expect(BM.instances.has('b1')).toBe(false);
  });

  it('创建中 terminate → 消费方 ready reject（getOrCreate settle）、迟到成品交 terminate 链关闭、无泄漏', async () => {
    const create = deferred<unknown>();
    const handle = BM.registerHandle('b1', () => create.promise);

    const settlement = handle.terminate('destroy during creation');
    expect(destroySpy).not.toHaveBeenCalled();   // 等创建 settle（有界）后才关

    const instance = fakeInstance('b1');
    create.resolve(instance);

    await expect(handle.ready).rejects.toThrow('terminated during creation');
    await settlement;
    expect(destroySpy).toHaveBeenCalledWith('b1', instance);   // 迟到成品被关闭，不是不可见泄漏
    expect(BM.instances.has('b1')).toBe(false);
  });

  it('创建失败 + 创建中 terminate：settlement 正常 settle、无实例可关、条目删除', async () => {
    const create = deferred<unknown>();
    const handle = BM.registerHandle('b1', () => create.promise);

    const settlement = handle.terminate('destroy');
    create.reject(new Error('launch failed'));

    await expect(handle.ready).rejects.toThrow('launch failed');
    await settlement;
    expect(destroySpy).not.toHaveBeenCalled();
    expect(BM.instances.has('b1')).toBe(false);
  });

  it('destroyInstance 失败 → settlement reject（边界终止无凭据）、条目保留、同一 rejected settlement 可反复消费', async () => {
    destroySpy.mockRejectedValue(new Error('SIGKILL failed'));
    const handle = BM.registerHandle('b1', () => Promise.resolve(fakeInstance('b1')));
    await handle.ready;

    const s1 = handle.terminate('stop');
    await expect(s1).rejects.toThrow('SIGKILL failed');
    expect(BM.instances.get('b1')).toBe(handle);   // 失败条目保留——半死边界在表上可见

    const s2 = handle.terminate('retry consume');
    expect(s2).toBe(s1);   // 幂等门闩：不重复发起硬关，同一失败凭据反复消费
    await expect(s2).rejects.toThrow('SIGKILL failed');
  });

  it('ready 失败自动清理带身份检查——新 handle 已顶替时不误删', async () => {
    // 场景 A：无顶替，失败即自清
    const createA = deferred<unknown>();
    const handleA = BM.registerHandle('b1', () => createA.promise);
    createA.reject(new Error('boom'));
    await expect(handleA.ready).rejects.toThrow('boom');
    await flushMicrotasks();
    expect(BM.instances.has('b1')).toBe(false);

    // 场景 B：旧 handle 失败回调迟到，新 handle 已登记 → 身份检查保住新条目
    const createOld = deferred<unknown>();
    const oldHandle = BM.registerHandle('b2', () => createOld.promise);
    const newHandle = BM.registerHandle('b2', () => Promise.resolve(fakeInstance('b2')));
    expect(BM.instances.get('b2')).toBe(newHandle);

    createOld.reject(new Error('old generation failed'));
    await expect(oldHandle.ready).rejects.toThrow('old generation failed');
    await flushMicrotasks();
    expect(BM.instances.get('b2')).toBe(newHandle);   // 未被旧世代的清理误删
  });

  it('创建超时经 handle settle（ready reject）；超时判负后迟到的成品被关闭', async () => {
    vi.useFakeTimers();
    const create = deferred<unknown>();
    const handle = BM.registerHandle('b1', () => create.promise);
    const readyOutcome = expect(handle.ready).rejects.toThrow('creation timed out');

    vi.advanceTimersByTime(60_000);
    await readyOutcome;

    // 迟到成品：不得成为不可见泄漏
    const late = fakeInstance('b1');
    create.resolve(late);
    await flushMicrotasks();
    expect(destroySpy).toHaveBeenCalledWith('b1', late);
  });
});

describe('BrowserHandle 有界终止（条目寿命 = rawCreation ∪ termination）', () => {
  it('超时判负 + 迟到成品 + close 失败 → 条目保留、rejection 在 termination 上可见', async () => {
    vi.useFakeTimers();
    destroySpy.mockRejectedValue(new Error('close failed'));
    const create = deferred<unknown>();
    const handle = BM.registerHandle('b1', () => create.promise);
    const readyOutcome = expect(handle.ready).rejects.toThrow('creation timed out');

    vi.advanceTimersByTime(60_000);
    await readyOutcome;

    const late = fakeInstance('b1');
    create.resolve(late);
    await flushMicrotasks();

    // 三重巧合下不得出现"无句柄、无租约、Chrome 存活"的不可见泄漏：
    expect(destroySpy).toHaveBeenCalledWith('b1', late);
    expect(BM.instances.get('b1')).toBe(handle);          // 关闭失败 → 条目保留（半死边界可见）
    await expect(handle.terminate('consume')).rejects.toThrow('close failed');   // 凭据可反复消费
  });

  it('termination 有界：rawCreation 超期不 settle → terminate 宽限一个创建超时级别后诚实 reject、条目保留', async () => {
    vi.useFakeTimers();
    const create = deferred<unknown>();   // 永不 settle
    const handle = BM.registerHandle('b1', () => create.promise);
    const readyOutcome = expect(handle.ready).rejects.toThrow('creation timed out');
    vi.advanceTimersByTime(60_000);
    await readyOutcome;

    const settlement = handle.terminate('stop');
    const outcome = expect(settlement).rejects.toThrow(/did not settle/);
    vi.advanceTimersByTime(120_000);   // 宽限期耗尽
    await outcome;
    expect(BM.instances.get('b1')).toBe(handle);   // 无边界终止凭据 → 条目保留
  });
});

describe('closeWithDeadline（graceful close 有界 + PID 升级）与退出兜底', () => {
  type BMWithClose = AnyBM & {
    closeWithDeadline(browserId: string, instance: unknown): Promise<void>;
  };
  const BMC = BrowserManager as unknown as BMWithClose;

  it('close 永不 settle（protocolTimeout: 0 CDP 卡死）→ 期限后升级 PID kill，kill 成功 = 终止凭据', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(BrowserManager, 'killProcessTreeByPid').mockResolvedValue(undefined);
    const instance = {
      browser: {
        close: () => new Promise(() => {}),
        process: () => ({ pid: 7777 }),
      },
    };
    const outcome = expect(BMC.closeWithDeadline('b1', instance)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(killSpy).toHaveBeenCalledWith(7777);
    killSpy.mockRestore();
  });

  it('close 挂起且无 PID → 诚实 reject（无升级手段，无凭据不报成功）', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(BrowserManager, 'killProcessTreeByPid').mockResolvedValue(undefined);
    /**
     * 必须桩掉 `readPersistedBrowserConfig`：`process()` 返回 null 时，实现会 `await readPersistedBrowserConfig()`
     * 去读持久化 PID —— 那是真实 fs I/O，在 fake timers 下**不受 advanceTimersByTimeAsync
     * 驱动**。于是 deadline 定时器可能在推进 5s 之后才被创建，rejection 永不触发，
     * 测试挂到 vitest 的真实 5s 超时。这一例本来就是"连持久化 PID 也没有"的场景，
     * 桩成同步 null 既消除竞态又更贴合语义。（此前该用例约 1/3 概率偶发失败。）
     */
    const persistedSpy = vi
      .spyOn(BMC as { readPersistedBrowserConfig: (id: string) => Promise<unknown> }, 'readPersistedBrowserConfig')
      .mockResolvedValue(null);
    const instance = {
      browser: { close: () => new Promise(() => {}), process: () => null },
    };
    const outcome = expect(BMC.closeWithDeadline('b1', instance)).rejects.toThrow(/did not settle/);
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
    persistedSpy.mockRestore();
  });

  it('PID kill 也失败 → reject（termination 无凭据，条目经失败路径保留）', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(BrowserManager, 'killProcessTreeByPid').mockRejectedValue(new Error('kill failed'));
    const instance = {
      browser: { close: () => new Promise(() => {}), process: () => ({ pid: 7777 }) },
    };
    const outcome = expect(BMC.closeWithDeadline('b1', instance)).rejects.toThrow('kill failed');
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    killSpy.mockRestore();
  });

  it('emergencyKillAll：terminate 挂住的实例经 getConsumed 仍可触达 PID（getReady 此时隐藏成品）', async () => {
    const killSpy = vi.spyOn(BrowserManager, 'killProcessTreeByPid').mockResolvedValue(undefined);
    destroySpy.mockReturnValue(new Promise(() => {}));   // 硬关挂死——兜底的主场景
    const instance = {
      id: 'b1',
      lastUsedAt: new Date(),
      browser: { process: () => ({ pid: 8888 }) },
    };
    const handle = BM.registerHandle('b1', () => Promise.resolve(instance));
    await handle.ready;
    void handle.terminate('stop');   // settlement 挂住
    expect(handle.getReady()).toBeUndefined();   // 常规访问器已隐藏

    await (BrowserManager as unknown as { emergencyKillAll(): Promise<void> }).emergencyKillAll();
    expect(killSpy).toHaveBeenCalledWith(8888);
    killSpy.mockRestore();
  });
});
