/**
 * 生命周期不变量 checker（五条断言中可快照对账的部分）。
 * 测试资产：确定性红灯与（后置可选的）模型跑器共用；不进 dist-electron 产物
 * （tsconfig.electron.json exclude electron/testing）。
 *
 * 五条断言的覆盖分工：
 *   ① activeRuntimes 条目恒 live            → 本 checker（快照）
 *   ② 占用↔注册表对账                       → 本 checker（快照）
 *   ③ runtime 引用消失必有凭据               → 由 agent.service.lifecycle.test.ts 的轨迹断言锁定
 *   ④ destroy 后 provider 调用数不增          → 轨迹断言，agent-engine.reasoning.test.ts 锁定
 *   ⑤ 所有权表条目恒映射底层操作事实           → 轨迹断言，browser-manager-handle.test.ts（契约 2）锁定
 */

/** 快照对账的最小事实面——真实占用与模型跑器的假占用皆可直接喂入 */
export interface OccupancyFact {
  key: string;
  occupantId: string;
  ownerId: string;
}

export interface LifecycleFacts {
  /** activeRuntimes 注册表条目 + destroy 凭据（destroy 已成功 settle 的条目必须已摘牌） */
  registeredRuntimes: Array<{ agentId: string; destroySettledOk: boolean }>;
  /** teardown 失败隔离标记（mainAgentId 集合） */
  failedTeardownRuns: ReadonlySet<string>;
  occupancies: OccupancyFact[];
  /** 占用者判活（占用者本人或其归属的顶层流程还在跑） */
  isOccupantAlive: (occupancy: OccupancyFact) => boolean;
  /** 占用归属的 mainAgentId（failedTeardowns 按 AgentRun 记账） */
  mainAgentIdOf: (occupancy: OccupancyFact) => string | undefined;
}

/**
 * 返回违反清单（空数组 = 全部不变量成立）。
 *
 * 断言②：占用登记里没有冻结态、没有回收宽限期，
 * 因此孤儿占用没有"期限内"一说——占用者已死且所属 AgentRun 未被隔离，出现即违反。
 */
export function checkLifecycleInvariants(facts: LifecycleFacts): string[] {
  const violations: string[] = [];

  // ① activeRuntimes 条目恒 live
  for (const entry of facts.registeredRuntimes) {
    if (entry.destroySettledOk) {
      violations.push(
        `①活性: activeRuntimes 仍含已成功 destroy 的 runtime ${entry.agentId}（摘牌必须在 destroy settlement 之后、且必须发生）`,
      );
    }
  }

  // ② 占用↔注册表对账
  for (const occupancy of facts.occupancies) {
    if (facts.isOccupantAlive(occupancy)) continue;

    const mainAgentId = facts.mainAgentIdOf(occupancy);
    if (mainAgentId && facts.failedTeardownRuns.has(mainAgentId)) continue;

    violations.push(
      `②对账: 孤儿占用 ${occupancy.key}（occupant=${occupancy.occupantId}）——占用者已死且未被隔离，出现即违反`,
    );
  }

  return violations;
}
