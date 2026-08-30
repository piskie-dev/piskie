/**
 * 工作区分组——thread 左栏的纯派生。
 *
 * 顶层单位 = **工作区**（`runConfig.workspace`），缺省归入「默认工作区」。
 * 二级 = 该工作区下的全部 thread（在跑的与历史的**同一列表**，见 `threadRows.ts`）。
 * **worker 不进左栏**——它短命、数量不定、信息密度需求高，改由主屏 agent tab 承载。
 *
 * 两条排序规则：
 * 1. **组内**走 `sortThreadRows`（在跑优先 → phase → 最近活跃倒序）；
 * 2. **组间**按「组内最近活跃」倒序。在跑的 thread `lastActiveAt` 天然最新，
 *    所以它所在的工作区自然浮到顶部，不需要额外给"有在跑的组"加权。
 *
 * **已知限制（用户已接受）**：工作区只能从 thread 的 `runConfig.workspace` 反推，
 * 没有独立的工作区注册表，所以**空工作区不可见**——第一个 thread 出现时工作区才出现，
 * 最后一个 thread 删除后工作区消失。threadApp 能列出空 project，本版不能。
 */

import { sortThreadRows, type ThreadRow } from './threadRows';

export interface WorkspaceGroup {
  /** 分组键：工作区路径，或缺省时的空串 */
  readonly key: string;
  /** 展示标签：路径末段，或「默认工作区」 */
  readonly label: string;
  /** 完整路径（tooltip 用；缺省工作区为 undefined） */
  readonly path?: string;
  readonly rows: readonly ThreadRow[];
}

/** 展示标签取路径末段——左栏 200–240px 放不下全路径 */
export function workspaceLabel(
  workspace: string | undefined,
  defaultLabel: string,
): string {
  if (!workspace) return defaultLabel;
  const segments = workspace.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.at(-1) || workspace;
}

function timeOf(row: ThreadRow): number {
  const time = new Date(row.lastActiveAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function groupByWorkspace(
  rows: readonly ThreadRow[],
  defaultLabel: string,
): readonly WorkspaceGroup[] {
  const buckets = new Map<string, ThreadRow[]>();

  for (const row of rows) {
    const key = row.workspace ?? '';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const groups = [...buckets.entries()].map<WorkspaceGroup>(([key, bucket]) => ({
    key,
    label: workspaceLabel(key || undefined, defaultLabel),
    path: key || undefined,
    rows: sortThreadRows(bucket),
  }));

  // 组间：按组内最近活跃倒序
  return groups.sort((a, b) => {
    const aLatest = Math.max(...a.rows.map(timeOf), 0);
    const bLatest = Math.max(...b.rows.map(timeOf), 0);
    return bLatest - aLatest;
  });
}
