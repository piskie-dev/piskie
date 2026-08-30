/**
 * 类层次 override 回归测试。
 * AgentRuntime 不得覆写基类的守卫与门闩，否则容易绕过 disposed 等公共检查。
 * 这些成员的唯一实现必须留在 AgentEngine：
 * - emitStateChange：disposed 源头抑制（销毁后无状态发布）
 * - destroy：幂等门闩（同一 settlement 反复消费）
 * - interrupt：activation abort 唯一发起点
 * - post：Mailbox 投递门（disposed 拒收）
 * 子类扩展一律走 protected 模板钩子（collectDestroyTasks / releaseResources 等），
 * 不得 shadow 上述公共成员。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp', on: () => undefined },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {},
}));

import { AgentRuntime } from '../agent-runtime.js';
import { AgentEngine } from '../agent-engine.js';

const GUARDED_MEMBERS = ['emitStateChange', 'destroy', 'interrupt', 'post'] as const;

describe('类层次 override 回潮锁定', () => {
  it.each(GUARDED_MEMBERS)('AgentRuntime 不得 shadow AgentEngine.%s（守卫/门闩唯一实现在基类）', (member) => {
    expect(Object.prototype.hasOwnProperty.call(AgentRuntime.prototype, member)).toBe(false);
    // prototype 同一性：经 AgentRuntime 实例查找到的就是基类实现
    expect(
      (AgentRuntime.prototype as unknown as Record<string, unknown>)[member],
    ).toBe((AgentEngine.prototype as unknown as Record<string, unknown>)[member]);
  });
});
