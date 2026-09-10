/**
 * 工作区分组——thread 左栏的纯派生。
 *
 * 顶层单位 = **工作区**（`runConfig.workspace`），缺省归入「默认工作区」。
 * 二级 = 该工作区下的全部 thread（在跑的与历史的**同一列表**，见 `threadRows.ts`）。
 * **worker 不进左栏**——它短命、数量不定、信息密度需求高，改由主屏 agent tab 承载。
 *
 * 两条排序规则：
 * 1. **组内**走 `sortThreadRows`（在跑优先 → phase → 最近活跃倒序）；
 * 2. **组间**先按「组内最近活跃」派生初始值，再由左栏应用持久化顺序；
 *    默认组只在首次初始化排第一，之后所有组都可以拖动。
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

/** 只用未搜索的全量分组更新顺序；保留暂时消失的 key，避免加载和删除扰乱其余组。 */
export function reconcileWorkspaceOrder(
  saved: readonly string[],
  groups: readonly WorkspaceGroup[],
): readonly string[] {
  const known = new Set(saved);
  const added = groups.map((group) => group.key).filter((key) => !known.has(key));
  if (added.length === 0) return saved;
  if (saved.length === 0 && added.includes('')) {
    return ['', ...added.filter((key) => key !== '')];
  }
  return [...saved, ...added];
}

export function orderWorkspaceGroups(
  groups: readonly WorkspaceGroup[],
  order: readonly string[],
): readonly WorkspaceGroup[] {
  const positions = new Map(order.map((key, index) => [key, index]));
  return [...groups].sort((a, b) => (
    (positions.get(a.key) ?? order.length) - (positions.get(b.key) ?? order.length)
  ));
}

export type WorkspaceDropEdge = 'before' | 'after';

export function moveWorkspaceGroup(
  order: readonly string[],
  source: string,
  target: string,
  edge: WorkspaceDropEdge,
): readonly string[] {
  // 拖动期间分组可能被删除；默认组的空 key 与其他 key 一样参与移动。
  if (source === target || !order.includes(source) || !order.includes(target)) return order;
  const next = order.filter((key) => key !== source);
  next.splice(next.indexOf(target) + (edge === 'after' ? 1 : 0), 0, source);
  return next;
}

/** 搜索只筛选已排序的分组，不生成另一份顺序。组名命中时展示组内全部行。 */
export function filterWorkspaceGroups(
  groups: readonly WorkspaceGroup[],
  query: string,
): readonly WorkspaceGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups.flatMap((group) => {
    if ([group.label, group.path].some((field) => field?.toLowerCase().includes(needle))) return [group];
    const rows = group.rows.filter((row) => row.label.toLowerCase().includes(needle));
    return rows.length > 0 ? [{ ...group, rows }] : [];
  });
}
