/** 定时任务页的纯展示判定：状态、分组、触发结果的色调。 */

import type { AgentControlSnapshot } from '@shared/electron-contracts/agent-runs';
import type { TaskDefinitionSnapshot } from '@shared/electron-contracts/task-definitions';
import { isScheduleActive, type ScheduleFireRecord, type ScheduleView } from '@shared/types/schedules';

export type LiveStates = Readonly<Record<string, AgentControlSnapshot>>;

export type ScheduleStatus = 'active' | 'paused' | 'suspended' | 'fired';

export type DirectoryGroup = 'attention' | 'active' | 'paused' | 'fired';

export const DIRECTORY_GROUPS: readonly DirectoryGroup[] = ['attention', 'active', 'paused', 'fired'];

/** 结果色调：ok 已启动 / err 启动失败 / skip 跳过。 */
export type FireTone = 'ok' | 'err' | 'skip';

export function scheduleStatus(view: ScheduleView): ScheduleStatus {
  if (view.state.suspended) return 'suspended';
  if (view.state.firedAt) return 'fired';
  if (!view.schedule.enabled) return 'paused';
  return 'active';
}

export function directoryGroup(view: ScheduleView): DirectoryGroup {
  if (view.state.suspended || view.state.consecutiveFailures > 0) {
    return 'attention';
  }
  if (view.state.firedAt) return 'fired';
  if (!view.schedule.enabled) return 'paused';
  return 'active';
}

export function fireTone(record: ScheduleFireRecord): FireTone {
  switch (record.outcome.kind) {
    case 'started':
    case 'injected':
      return 'ok';
    case 'skipped':
      return 'skip';
    case 'failed':
      return 'err';
  }
}

export function recordAgentId(record: ScheduleFireRecord): string | undefined {
  const { outcome } = record;
  return outcome.kind === 'started' || outcome.kind === 'injected' ? outcome.agentId : undefined;
}

export function definitionIdOf(view: ScheduleView): string | undefined {
  const { action } = view.schedule;
  return action.kind === 'new_run' && action.launch.kind === 'definition'
    ? action.launch.definitionId
    : undefined;
}

export function templateOf(
  view: ScheduleView,
  definitions: readonly TaskDefinitionSnapshot[],
): TaskDefinitionSnapshot | undefined {
  const definitionId = definitionIdOf(view);
  return definitionId ? definitions.find((item) => item.definitionId === definitionId) : undefined;
}

export function orderDefinitionsByAvailability(
  definitions: readonly TaskDefinitionSnapshot[],
  boundTemplates: ReadonlyMap<string, string>,
): TaskDefinitionSnapshot[] {
  const available: TaskDefinitionSnapshot[] = [];
  const bound: TaskDefinitionSnapshot[] = [];
  for (const definition of definitions) {
    (boundTemplates.has(definition.definitionId) ? bound : available).push(definition);
  }
  return [...available, ...bound];
}

/** 任务到点交付的指令原文：模板任务来自模板，工具创建的任务来自 agent 留下的 prompt。 */
export function promptOf(
  view: ScheduleView,
  definitions: readonly TaskDefinitionSnapshot[],
): string | undefined {
  const { action } = view.schedule;
  if (action.kind === 'inject') return action.prompt;
  if ('prompt' in action) return action.prompt;
  return templateOf(view, definitions)?.promptTemplate;
}

export function matchesQuery(
  view: ScheduleView,
  query: string,
  definitions: readonly TaskDefinitionSnapshot[],
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [
    view.schedule.name,
    view.schedule.scheduleId,
    promptOf(view, definitions) ?? '',
    templateOf(view, definitions)?.name ?? '',
  ].join('\n').toLocaleLowerCase();
  return haystack.includes(needle);
}

export { isScheduleActive };
