/**
 * 占用登记表。
 *
 * 覆盖排他冲突报告、同占用者刷新、同环境再派发时序，以及 teardown 释放后重取。
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';



import { occupancyRegistry } from '../registry.js';
import { occupancyKey, type ClaimRequest } from '../../../../shared/types/occupancy.js';

const req = (occupantId: string, over: Partial<ClaimRequest> = {}): ClaimRequest => ({
  kind: 'browserEnvironment',
  resourceId: 'user-taobao',
  occupantId,
  ownerId: occupantId,
  occupantName: occupantId,
  ...over,
});

const ENVIRONMENT_KEY = occupancyKey('browserEnvironment', 'user-taobao');
let stopChanges: (() => void) | undefined;

beforeEach(() => {
  stopChanges?.();
  stopChanges = undefined;
  occupancyRegistry.clear();
});

afterEach(() => {
  stopChanges?.();
  stopChanges = undefined;
});

describe('排他占用', () => {
  it('同 key 不同占用者：冲突被拒、原记录不被覆盖', () => {
    expect(occupancyRegistry.claim(req('flow-A-agent')).ok).toBe(true);

    const result = occupancyRegistry.claim(req('flow-B-agent'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.heldBy.occupantId).toBe('flow-A-agent');

    expect(occupancyRegistry.find(ENVIRONMENT_KEY)?.occupantId).toBe('flow-A-agent');
  });

  it('同占用者重复 claim 不算冲突（刷新）', () => {
    occupancyRegistry.claim(req('flow-A-agent'));
    expect(occupancyRegistry.claim(req('flow-A-agent')).ok).toBe(true);
    expect(occupancyRegistry.list()).toHaveLength(1);
  });

  it('同环境再派发时序：旧占用者未释放被拒 → 释放后新占用者重取成功', () => {
    // 对应提示词「同一环境可再次派发，但须待旧子流程回收释放；需立即复用先停止旧子流程」
    expect(occupancyRegistry.claim(req('old-subagent')).ok).toBe(true);

    const retry = occupancyRegistry.claim(req('new-subagent'));
    expect(retry.ok).toBe(false);
    expect(retry.ok === false && retry.heldBy.occupantId).toBe('old-subagent');

    expect(occupancyRegistry.releaseAllOwnedBy('old-subagent')).toBeGreaterThan(0);
    expect(occupancyRegistry.claim(req('new-subagent')).ok).toBe(true);
  });

  it('kind 相同才算同一资源：不同 kind 的同名 id 互不冲突', () => {
    expect(occupancyRegistry.claim(req('a', { kind: 'browserEnvironment', resourceId: 'x' })).ok).toBe(true);
    expect(occupancyRegistry.claim(req('b', { kind: 'browserInstance', resourceId: 'x' })).ok).toBe(true);
  });
});

describe('releaseAllOwnedBy（唯一释放出口）', () => {
  it('释放 agent 本体与其子代理的全部占用，不动他人', () => {
    occupancyRegistry.claim(req('main-1'));
    occupancyRegistry.claim(req('sub-1', { resourceId: 'sub', ownerId: 'main-1' }));
    occupancyRegistry.claim(req('other', { resourceId: 'other' }));

    expect(occupancyRegistry.releaseAllOwnedBy('main-1')).toBe(2);
    expect(occupancyRegistry.list()).toHaveLength(1);
    expect(occupancyRegistry.list()[0]!.occupantId).toBe('other');
  });

  it('无匹配条目时返回 0 且不广播', () => {
    const onChange = vi.fn();
    stopChanges = occupancyRegistry.subscribe(onChange);
    occupancyRegistry.claim(req('main-1'));
    onChange.mockClear();

    expect(occupancyRegistry.releaseAllOwnedBy('nobody')).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('变更广播', () => {
  it('claim / release 各广播一次全量快照', () => {
    const onChange = vi.fn();
    stopChanges = occupancyRegistry.subscribe(onChange);

    occupancyRegistry.claim(req('main-1'));
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ key: ENVIRONMENT_KEY })]);
    const [snapshot] = onChange.mock.calls.at(-1)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);

    occupancyRegistry.releaseAllOwnedBy('main-1');
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
