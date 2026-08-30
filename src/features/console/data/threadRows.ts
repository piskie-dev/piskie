/**
 * ThreadRow —— thread 左栏的唯一行模型。
 *
 * `agentId` 是唯一身份。磁盘 Header 与同一个 AgentRun 的实时控制态合成一行；
 * 同一 TaskDefinition 启动多次会得到不同 agentId，因此始终显示为多行。
 */

import { phaseOrder, type HistoryRow, type SessionRow } from './sessionRow';

export interface ThreadRow {
  /** 稳定 key：`agent:<agentId>` */
  readonly key: string;
  readonly agentId: string;
  readonly label: string;
  readonly workspace?: string;
  /** 排序用；live 行没有历史条目时退回 `createdAt` */
  readonly lastActiveAt: string;
  /** 有值即在跑。合并后这是"运行中"唯一的结构性体现 */
  readonly live?: SessionRow;
  /** 历史源行；恢复会话需要原样回传 */
  readonly history?: HistoryRow;
}

function timeOf(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function keyOf(row: { readonly agentId: string }): string {
  return `agent:${row.agentId}`;
}

export function buildThreadRows(input: {
  readonly sessions: readonly SessionRow[];
  readonly history: readonly HistoryRow[];
}): readonly ThreadRow[] {
  // 防御重复投影只按同一个 AgentRun 去重，不跨 agentId 合并。
  const live = new Map<string, SessionRow>();
  for (const session of input.sessions) {
    const key = keyOf(session);
    const current = live.get(key);
    if (!current || timeOf(session.createdAt) > timeOf(current.createdAt)) live.set(key, session);
  }

  const merged = new Map<string, ThreadRow>();

  for (const [key, session] of live) {
    merged.set(key, {
      key,
      agentId: session.agentId,
      label: session.description?.trim() || session.title,
      workspace: session.workspace,
      lastActiveAt: session.createdAt,
      live: session,
    });
  }

  // 同一个 AgentRun 的磁盘态与实时态合成一行。
  for (const row of input.history) {
    const key = keyOf(row);
    const existing = merged.get(key);

    if (existing) {
      merged.set(key, {
        ...existing,
        label: row.taskDescription,
        workspace: existing.workspace ?? row.workspace,
        lastActiveAt:
          timeOf(row.lastActiveAt) > timeOf(existing.lastActiveAt) ? row.lastActiveAt : existing.lastActiveAt,
        history: row,
      });
      continue;
    }

    merged.set(key, {
      key,
      agentId: row.agentId,
      label: row.taskDescription,
      workspace: row.workspace,
      lastActiveAt: row.lastActiveAt,
      history: row,
    });
  }

  return [...merged.values()];
}

/**
 * 组内排序：在跑的恒在前（同为在跑时按 phase 细分），其余按最近活跃倒序。
 *
 * 这里不再走 `sortSessionRows`——它只认 `SessionRow` 且不处理 live/history 混排，
 * 但 phase 权重仍取自 `phaseOrder` 同一张表。
 */
export function sortThreadRows(rows: readonly ThreadRow[]): ThreadRow[] {
  return [...rows].sort((a, b) => {
    if (!!a.live !== !!b.live) return a.live ? -1 : 1;

    if (a.live && b.live) {
      const order = phaseOrder(a.live.phase) - phaseOrder(b.live.phase);
      if (order !== 0) return order;
    }

    return timeOf(b.lastActiveAt) - timeOf(a.lastActiveAt);
  });
}
