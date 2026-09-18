import type { AgentRunBindings } from './task-bindings.js';
import type { ApprovalMode, TaskAdvancedSettings } from './index.js';

/** 触发形式。`once.at` 是创建时换算好的绝对时刻（ISO）；`cron` 为 5 字段表达式加 IANA 时区。 */
export type ScheduleTrigger =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string; timezone: string };

/** 工具创建的 `new_run` 从创建者 runConfig 快照的运行设置，与 `agent_run` 取同一组字段。 */
export interface ScheduleInlineLaunch {
  kind: 'inline';
  workspace?: string;
  bindings?: AgentRunBindings;
  advancedSettings?: TaskAdvancedSettings;
  mcpServers?: string[];
  approvalMode: ApprovalMode;
  model?: string;
}

/** 用户创建的唯一形态：指令与全部运行设置来自模板，这里不复制任何一项。 */
export interface ScheduleDefinitionLaunch {
  kind: 'definition';
  definitionId: string;
}

export type ScheduleAction =
  | { kind: 'new_run'; launch: ScheduleDefinitionLaunch }
  | { kind: 'new_run'; prompt: string; launch: ScheduleInlineLaunch }
  | { kind: 'inject'; prompt: string; agentId: string };

export type ScheduleCreator =
  | { kind: 'user' }
  | { kind: 'agent'; agentId: string };

/** 定时任务定义（用户意图，Config Domain `schedules`）。 */
export interface Schedule {
  scheduleId: string;
  /** trim 后 1-40 字符。 */
  name: string;
  /** 用户意图；系统挂起另见 `ScheduleTaskState.suspended`。 */
  enabled: boolean;
  trigger: ScheduleTrigger;
  /** 错过后补跑一次（true）或跳过并记录（false）。 */
  runIfMissed: boolean;
  action: ScheduleAction;
  createdBy: ScheduleCreator;
  createdAt: string;
}

/** 系统挂起原因；用户重新启用时清除。 */
export type ScheduleSuspension =
  | { code: 'consecutive-failures'; count: number; message: string }
  | { code: 'template-deleted' }
  | { code: 'target-missing' };

/** 单个任务的运行状态（系统事实，调度器独占写入）。 */
export interface ScheduleTaskState {
  /** 下次触发的计算锚点：最近一次触发处理完成的时刻。 */
  lastFiredAt?: string;
  /** `new_run` 的租约：这个任务当前占着的内存运行。 */
  lastAgentId?: string;
  consecutiveFailures: number;
  suspended?: ScheduleSuspension;
  /** 一次性任务触发后写入，进入「已触发」。 */
  firedAt?: string;
}

export type FireOutcome =
  | { kind: 'started'; agentId: string }
  | { kind: 'injected'; agentId: string }
  | { kind: 'skipped'; reason: 'overlap' | 'missed' }
  | { kind: 'failed'; stage: 'start' | 'inject' | 'interrupted'; message: string };

/** 一次触发的记录，只到启动层面；运行之后完成与否这里不知道也不记录。 */
export interface FireRecord {
  scheduledFor: string;
  firedAt: string;
  outcome: FireOutcome;
  /** 用户点「立即运行」触发，不占用计划时刻。 */
  manual?: true;
}

export interface ScheduleFireRecord extends FireRecord {
  scheduleId: string;
}

/** 渲染层看到的一条任务：定义、状态与派生的下次触发时刻。 */
export interface ScheduleView {
  schedule: Schedule;
  state: ScheduleTaskState;
  /** 有效活跃任务的下次触发时刻；已挂起、已暂停、已触发的一次性任务为 null。 */
  nextRunAt: string | null;
}

export interface SchedulesSnapshot {
  items: ScheduleView[];
}

export type ScheduleNotice =
  | { kind: 'started'; scheduleId: string; name: string; agentId: string }
  | { kind: 'suspended'; scheduleId: string; name: string; suspension: ScheduleSuspension };

/** 有效活跃 = 已启用、未被系统挂起、且不是已触发的一次性任务。 */
export function isScheduleActive(schedule: Schedule, state: ScheduleTaskState): boolean {
  return schedule.enabled && !state.suspended && !state.firedAt;
}
