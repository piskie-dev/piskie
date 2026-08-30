/**
 * 生命周期 checker 的两类快照断言自测。
 */
import { describe, it, expect, vi } from 'vitest';



import { checkLifecycleInvariants, type LifecycleFacts, type OccupancyFact } from '../lifecycle-invariants.js';

const occupancy = (over: Partial<OccupancyFact> = {}): OccupancyFact => ({
  key: 'browserEnvironment:environment-a',
  occupantId: 'sub-1',
  ownerId: 'main-1',
  ...over,
});

const facts = (over: Partial<LifecycleFacts> = {}): LifecycleFacts => ({
  registeredRuntimes: [],
  failedTeardownRuns: new Set(),
  occupancies: [],
  isOccupantAlive: () => false,
  mainAgentIdOf: () => 'main-1',
  ...over,
});

describe('checkLifecycleInvariants', () => {
  it('健康快照：无违反', () => {
    expect(checkLifecycleInvariants(facts({
      registeredRuntimes: [{ agentId: 'a1', destroySettledOk: false }],
      occupancies: [occupancy()],
      isOccupantAlive: () => true,
    }))).toEqual([]);
  });

  it('①：已成功 destroy 的 runtime 仍在注册表 → 违反', () => {
    const violations = checkLifecycleInvariants(facts({
      registeredRuntimes: [{ agentId: 'a1', destroySettledOk: true }],
    }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('①');
  });

  it('②：占用者已死 → 孤儿占用，出现即违反（无宽限期）', () => {
    const violations = checkLifecycleInvariants(facts({ occupancies: [occupancy()] }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('孤儿占用');
  });

  it('②：孤儿经 failedTeardowns 隔离豁免（保留即隔离）', () => {
    expect(checkLifecycleInvariants(facts({
      occupancies: [occupancy()],
      failedTeardownRuns: new Set(['main-1']),
    }))).toEqual([]);
  });
});
