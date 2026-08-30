/**
 * 会话行的**纯**部分（类型 + 排序 + 文案派生）。
 *
 * 与 `session.ts` 分开是必需的，不是洁癖：`session.ts` 组合 Renderer Runtime hooks，
 * 纯逻辑放这里后，`workspaceGroups` 与它的测试不必加载 React 或运行时环境。
 * （与 `content/gates/resolve.ts` 同一个理由。）
 *
 * 排序规则：
 * - 运行中：按 phase 优先级（executing → thinking → waiting → stopping），同级按 createdAt 倒序
 * - 历史：按 `lastActiveAt` 倒序（后端去重后已排好，前端不再排）
 */

import type { AgentPhase } from '../../../../shared/types/agent-control';
import type { ActivitySummary } from './useActivitySummary';
import type { StatusKey } from './status';

const PHASE_ORDER: Record<string, number> = {
  executing: 0,
  thinking: 1,
  waiting: 2,
  stopping: 3,
};

export interface SessionRow {
  readonly agentId: string;
  readonly title: string;
  readonly description?: string;
  /** 工作区路径；thread 左栏按它分组（缺省归入「默认工作区」） */
  readonly workspace?: string;
  /**
   * 排序键。**必须是 phase 而不是 status**：phase 表的档位是
   * executing→thinking→waiting→stopping，而 `resolveStatus` 会把 executing 折成
   * `'running'`——拿 status 去查 phase 表，运行中的会话会掉到兜底档排到最后。
   */
  readonly phase: AgentPhase;
  readonly status: StatusKey;
  readonly createdAt: string;
  readonly workerCount: number;
  readonly model: string;
  readonly interrupted: boolean;
  /**
   * 「在干什么」——左栏当前会话摘要（`resolveActivitySummary`）。
   * 这里不传 `cells`：侧栏拿不到流水。
   */
  readonly activity: ActivitySummary;
  /** 分组轴预留；本版恒 undefined */
  readonly groupKey?: string;
}

export interface HistoryRow {
  readonly agentId: string;
  readonly title: string;
  readonly description?: string;
  readonly agentSpec: string;
  /** 用户任务描述：description → promptTemplate 截断 → run name */
  readonly taskDescription: string;
  readonly workspace?: string;
  readonly lastActiveAt: string;
  /** 该历史会话当前是否已加载（在跑） */
  readonly running: boolean;
}

/**
 * 历史行的文案：用户任务描述优先。
 * 快速聊天的 `description` 是用户原话；任务定义启动也保存完整运行快照。
 * 描述为空时使用 promptTemplate 截断兜底，最后退回运行名称。
 */
export function resolveTaskDescription(header: {
  agentId: string;
  runConfig: { name?: string; description?: string; promptTemplate?: string };
}): string {
  const description = header.runConfig.description?.trim();
  if (description) return description;

  const template = header.runConfig.promptTemplate?.trim();
  if (template) return template.length > 100 ? `${template.slice(0, 100)}…` : template;

  return header.runConfig.name?.trim() || header.agentId;
}

/**
 * phase 的排序权重。**导出**是为了让 `threadRows` 的比较器复用同一张表——
 * thread 左栏合并成单一工作区树后，"在跑的排前面"这条也要按 phase 细分，
 * 抄第二份表迟早漂移。
 */
export function phaseOrder(phase: AgentPhase): number {
  return PHASE_ORDER[phase] ?? 4;
}

/** 纯函数版本，供测试直接调用 */
export function sortSessionRows(rows: readonly SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    const aOrder = phaseOrder(a.phase);
    const bOrder = phaseOrder(b.phase);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
