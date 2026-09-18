import type { AgentRunConfig, TaskDefinition } from '../../shared/types/index.js';
import type { AgentControlState } from '../../shared/types/agent-control.js';
import type { Schedule, ScheduleNotice } from '../../shared/types/schedules.js';
import type { ChangeSource } from '../core/change-channel.js';
import type { DirectorLaunchOptions } from '../agent/launch/start-director-run.js';
import type { ScheduleHistoryStore } from './schedule-history-store.js';
import type { ScheduleStateStore } from './schedule-state-store.js';

/** 定义来源：Config Domain 发布到的内存存储。 */
export interface ScheduleDefinitionSource {
  list(): readonly Schedule[];
  changes: ChangeSource<readonly Schedule[]>;
}

export interface ScheduleTemplateSource {
  get(definitionId: string): TaskDefinition | null;
}

/** 调度器对 Agent 运行的全部需要：起一个 Director 运行、往会话注入、看状态、停掉空闲运行。 */
export interface SchedulerAgentPort {
  startRun(
    runConfig: AgentRunConfig,
    options: DirectorLaunchOptions,
  ): Promise<{ agentId: string }>;
  /** false = 目标会话已不存在。 */
  inject(agentId: string, content: string): Promise<boolean>;
  /** null = 不在内存中。 */
  controlState(agentId: string): AgentControlState | null;
  stop(agentId: string): Promise<void>;
}

export interface SchedulerPorts {
  definitions: ScheduleDefinitionSource;
  templates: ScheduleTemplateSource;
  agents: SchedulerAgentPort;
  state: ScheduleStateStore;
  history: ScheduleHistoryStore;
  now?: () => Date;
  notify?: (notice: ScheduleNotice) => void;
  /** 任一任务状态落盘后调用，供能力层重新投影快照。 */
  onStateChanged?: () => void;
}
