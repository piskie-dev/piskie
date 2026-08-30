/**
 * 天际栏 token 汇总。
 *
 * 口径:本次启动以来所有 LLM 请求 token 的纯加法汇总——每个会话/子代理的
 * runMetrics 已各自统计,这里只做差量吸收:读数上涨记增量;目标离场(停止/
 * 删除)不回落;会话恢复后 runMetrics 从零重计时只重置基线、不做减法。
 * 纯内存汇总统计对象,不持久化、不新增任何后端字段,应用重启归零。
 */

import type { AgentControlTarget } from '../../domains/agent-control/agent-control-store';

export interface TokenTally {
  /** 单调不减的累计值,天际栏直接展示 */
  total: number;
  /** 各目标(主代理与子代理各占一条)上次读数基线 */
  baselines: Record<string, number>;
}

export function createTokenTally(): TokenTally {
  return { total: 0, baselines: {} };
}

function readingOf(target: AgentControlTarget): number {
  const metrics = target.state.runMetrics;
  return metrics.inputTokens + metrics.outputTokens;
}

/**
 * 吸收一帧控制状态快照并返回最新累计值。
 * 幂等:同一快照重复吸收(如 StrictMode 双调)增量为零,结果不变。
 */
export function absorbTargets(
  tally: TokenTally,
  targetsById: Readonly<Record<string, AgentControlTarget>>,
): number {
  for (const [targetId, target] of Object.entries(targetsById)) {
    const reading = readingOf(target);
    const baseline = tally.baselines[targetId] ?? 0;
    if (reading > baseline) tally.total += reading - baseline;
    tally.baselines[targetId] = reading;
  }
  return tally.total;
}

/** 渲染进程生命周期内的唯一账本(重启即新账) */
export const sessionTokenTally = createTokenTally();
