/**
 * 会话卡片溢出菜单的可见性策略（出口可见性由 shared 谓词单一来源决定）。
 *
 * 单一来源是 `canPause` / `canStop` 这两个 shared 谓词。这里直接调谓词、产出与 UI 无关的
 * 描述符（图标由组件按 key 映射，不引 AntD——Console 被 `.eslintrc.cjs` 的
 * `no-restricted-imports` 挡着不能拖进 antd 与 @ant-design/icons）：
 * 工作区与 AgentRun Trace 恒有；`canPause` 才有暂停；`canStop` 才有停止（danger）。
 */

import type { AgentPhase } from '../../../../shared/types/agent-control';
import { canPause, canStop } from '../../../../shared/types/agent-control';

export type SessionMenuKey = 'workspace' | 'trace' | 'pause' | 'stop';

export interface SessionMenuItem {
  readonly key: SessionMenuKey;
  readonly danger?: boolean;
}

/** 谓词只需要这些字段——收窄入参，避免内容层依赖控制态全量类型 */
export interface SessionMenuSource {
  readonly phase: AgentPhase;
  readonly pendingQuestion?: unknown;
  readonly children?: ReadonlyArray<{ phase: AgentPhase; pendingQuestion?: unknown }>;
  readonly agentId?: string;
}

export function buildSessionMenu(source: SessionMenuSource): readonly SessionMenuItem[] {
  const items: SessionMenuItem[] = [{ key: 'workspace' }];

  if (source.agentId) items.push({ key: 'trace' });
  if (canPause(source)) items.push({ key: 'pause' });
  if (canStop(source)) items.push({ key: 'stop', danger: true });

  return items;
}

export interface HistoryMenuItem {
  readonly key: 'open' | 'trace' | 'delete';
  readonly danger?: boolean;
}

export function buildHistoryMenu(options: { readonly deletable: boolean }): readonly HistoryMenuItem[] {
  const items: HistoryMenuItem[] = [
    { key: 'open' },
    { key: 'trace' },
  ];
  if (options.deletable) items.push({ key: 'delete', danger: true });
  return items;
}
