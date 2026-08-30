/** Activation-scoped values and runtime ports contributed by roles/modules. */

import type {
  AssignmentTaskBoardSnapshot,
  AgentRunConfig,
  SubagentConfig,
} from '../../shared/types/index.js';
import type { SkillInventorySnapshot } from '../../shared/types/skill.js';
import type {
  EventPort,
  ImageOpsPort,
  ModesPort,
  PlanPort,
  SubagentPort,
  TaskBoardPort,
  ToolResourceIds,
} from '../tools/types.js';
import type { BrowserHostRuntime } from '../piskiepilot/core/skill/host.js';
import type { RoleType } from './roles/role.js';

export interface AgentInfo {
  agentId: string;
  agentSpec: string;
  role: RoleType;
  mainAgentId: string;
  runConfig?: AgentRunConfig;
  subagentConfig?: SubagentConfig;
  allowedCustomTools?: string[];
  excludeTools?: string[];
}

export interface TypedToolContext {
  readonly agentInfo: Readonly<AgentInfo>;
  readonly resourceIds: ToolResourceIds;
  readonly assignmentSnapshot?: Readonly<AssignmentTaskBoardSnapshot>;
  readonly skillInventory?: Readonly<SkillInventorySnapshot>;
  readonly modes: ModesPort;
  readonly taskBoard?: TaskBoardPort;
  readonly plan?: PlanPort;
  readonly subagents?: SubagentPort;
  readonly events?: EventPort;
  readonly imageOps?: ImageOpsPort;
  readonly browser?: BrowserHostRuntime;
}

export class ToolContextBuilder {
  private _agentInfo?: AgentInfo;
  private _resourceIds: ToolResourceIds = {};
  private _assignmentSnapshot?: AssignmentTaskBoardSnapshot;
  private _skillInventory?: SkillInventorySnapshot;
  private _modes?: ModesPort;
  private _taskBoard?: TaskBoardPort;
  private _plan?: PlanPort;
  private _subagents?: SubagentPort;
  private _events?: EventPort;
  private _imageOps?: ImageOpsPort;
  private _browser?: BrowserHostRuntime;

  setAgentInfo(info: AgentInfo): this {
    this._agentInfo = info;
    return this;
  }

  setToolFace(allowedCustomTools: string[] | undefined, excludeTools: string[] | undefined): this {
    if (!this._agentInfo) {
      throw new Error('ToolContextBuilder: setAgentInfo must run before setToolFace');
    }
    this._agentInfo.allowedCustomTools = allowedCustomTools;
    this._agentInfo.excludeTools = excludeTools;
    return this;
  }

  addResourceIds(ids: ToolResourceIds): this {
    this._resourceIds = { ...this._resourceIds, ...ids };
    return this;
  }

  setAssignmentSnapshot(snapshot: AssignmentTaskBoardSnapshot | undefined): this {
    this._assignmentSnapshot = snapshot;
    return this;
  }

  /** 注入时刻的 <available_skills> manifest 快照（tool_search 互斥基准） */
  setSkillInventory(snapshot: SkillInventorySnapshot | undefined): this {
    this._skillInventory = snapshot;
    return this;
  }

  setModes(port: ModesPort): this {
    this._modes = port;
    return this;
  }

  setTaskBoard(port: TaskBoardPort): this {
    this._taskBoard = port;
    return this;
  }

  setPlan(port: PlanPort): this {
    this._plan = port;
    return this;
  }

  setSubagents(port: SubagentPort): this {
    this._subagents = port;
    return this;
  }

  setEvents(port: EventPort): this {
    this._events = port;
    return this;
  }

  setImageOps(ops: ImageOpsPort): this {
    this._imageOps = ops;
    return this;
  }

  setBrowser(runtime: BrowserHostRuntime): this {
    this._browser = runtime;
    return this;
  }

  build(): TypedToolContext {
    if (!this._agentInfo) {
      throw new Error('ToolContextBuilder: agentInfo is required');
    }
    if (!this._modes) {
      throw new Error('ToolContextBuilder: modes port is required');
    }

    const agentInfo = Object.freeze({
      ...this._agentInfo,
      runConfig: this._agentInfo.runConfig
        ? Object.freeze({ ...this._agentInfo.runConfig })
        : undefined,
      subagentConfig: this._agentInfo.subagentConfig
        ? Object.freeze({ ...this._agentInfo.subagentConfig })
        : undefined,
      allowedCustomTools: this._agentInfo.allowedCustomTools
        ? Object.freeze([...this._agentInfo.allowedCustomTools]) as unknown as string[]
        : undefined,
      excludeTools: this._agentInfo.excludeTools
        ? Object.freeze([...this._agentInfo.excludeTools]) as unknown as string[]
        : undefined,
    });

    return Object.freeze({
      agentInfo,
      resourceIds: Object.freeze({ ...this._resourceIds }),
      assignmentSnapshot: this._assignmentSnapshot
        ? Object.freeze({ ...this._assignmentSnapshot })
        : undefined,
      skillInventory: this._skillInventory
        ? Object.freeze({ ...this._skillInventory })
        : undefined,
      modes: this._modes,
      taskBoard: this._taskBoard,
      plan: this._plan,
      subagents: this._subagents,
      events: this._events,
      imageOps: this._imageOps,
      browser: this._browser,
    });
  }
}
