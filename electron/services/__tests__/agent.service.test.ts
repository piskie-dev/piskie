import { describe, expect, it } from 'vitest';

/**
 * AgentService 锁机制测试
 *
 * 由于 AgentService 是单例且深度依赖 AgentRuntime、piskiepilot、localStore 等，
 * 这里直接测试核心逻辑：生命周期串行器的并发安全性。
 * 集成测试由手动启动应用验证。
 */

// ============================================================
// 生命周期串行器并发安全性测试
// ============================================================

describe('lifecycle serialization concurrency', () => {
  /**
   * 模拟 AgentService 的生命周期串行器实现
   * 提取为独立函数方便单元测试
   */
  function createLockManager() {
    const locks = new Map<string, Promise<void>>();

    async function serializeLifecycle<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
      const prev = locks.get(agentId) ?? Promise.resolve();
      let resolve: () => void;
      const current = new Promise<void>(r => { resolve = r; });
      locks.set(agentId, current);

      await prev;
      try {
        return await fn();
      } finally {
        resolve!();
        if (locks.get(agentId) === current) {
          locks.delete(agentId);
        }
      }
    }

    return { serializeLifecycle, locks };
  }

  it('serializes operations on the same agentId', async () => {
    const { serializeLifecycle } = createLockManager();
    const order: number[] = [];

    const op1 = serializeLifecycle('agent-1', async () => {
      order.push(1);
      await new Promise(r => setTimeout(r, 50));
      order.push(2);
    });

    const op2 = serializeLifecycle('agent-1', async () => {
      order.push(3);
    });

    await Promise.all([op1, op2]);
    expect(order).toEqual([1, 2, 3]); // op2 waits for op1
  });

  it('allows parallel operations on different agentIds', async () => {
    const { serializeLifecycle } = createLockManager();
    const order: string[] = [];

    const op1 = serializeLifecycle('agent-1', async () => {
      order.push('a-start');
      await new Promise(r => setTimeout(r, 50));
      order.push('a-end');
    });

    const op2 = serializeLifecycle('agent-2', async () => {
      order.push('b-start');
      await new Promise(r => setTimeout(r, 10));
      order.push('b-end');
    });

    await Promise.all([op1, op2]);
    // Both should start before either ends
    expect(order.indexOf('a-start')).toBeLessThan(order.indexOf('a-end'));
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('b-end'));
    // b should end before a (shorter delay)
    expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
  });

  it('releases lock even if operation throws', async () => {
    const { serializeLifecycle } = createLockManager();
    const order: number[] = [];

    try {
      await serializeLifecycle('agent-1', async () => {
        order.push(1);
        throw new Error('boom');
      });
    } catch {
      // expected
    }

    // Next operation should proceed (lock released)
    await serializeLifecycle('agent-1', async () => {
      order.push(2);
    });

    expect(order).toEqual([1, 2]);
  });

  it('queues three operations correctly', async () => {
    const { serializeLifecycle } = createLockManager();
    const order: number[] = [];

    const op1 = serializeLifecycle('agent-1', async () => {
      await new Promise(r => setTimeout(r, 30));
      order.push(1);
    });

    const op2 = serializeLifecycle('agent-1', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(2);
    });

    const op3 = serializeLifecycle('agent-1', async () => {
      order.push(3);
    });

    await Promise.all([op1, op2, op3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('cleans up lock map after last operation', async () => {
    const { serializeLifecycle, locks } = createLockManager();

    await serializeLifecycle('agent-1', async () => {});
    expect(locks.has('agent-1')).toBe(false);
  });
});
