import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * PlanModule — 计划模式切换和管理
 *
 * Plan 与 Task Board 分别落盘；本模块只保留可丢弃的 UI 投影。
 */

import type { AgentModule } from './module.js';
import type { AgentHost } from '../agent-host.js';
import type { ToolContextBuilder } from '../tool-context.js';
import type { AgentModeId, TaskItem } from '../../../shared/types/index.js';
export type TaskBoardState = { taskSummary: string; items: TaskItem[] };

export class PlanModule implements AgentModule {
  readonly name = 'plan';
  private host!: AgentHost;

  private modeId: AgentModeId = 'normal';
  private returnModeId: AgentModeId | null = null;
  private currentPlanId: string | null = null;
  private taskBoard: TaskBoardState | null = null;
  private mainAgentId = '_unknown';

  init(host: AgentHost, config: Record<string, unknown>): void {
    this.host = host;
    if (config.defaultModeId) {
      this.modeId = config.defaultModeId as AgentModeId;
    }
    if (config.mainAgentId) {
      this.mainAgentId = config.mainAgentId as string;
    }
    // 从磁盘恢复计划指针与 Task Board 投影。
    void this.restoreFromDisk();
  }

  private async restoreFromDisk(): Promise<void> {
    try {
      const { planRepository } = await import('../../agent-runs/plan-repository.js');
      const plan = await planRepository.readCurrentPlan(this.mainAgentId);
      if (plan) {
        this.currentPlanId = plan.planId;
      }
      const { taskBoardService } = await import('../../agent-runs/task-board-service.js');
      const taskBoard = await taskBoardService.readTaskBoard(this.mainAgentId);
      if (taskBoard) {
        this.taskBoard = { taskSummary: taskBoard.taskSummary, items: taskBoard.items };
        this.host.emitStateChange();
      }
    } catch (error) {
      appLog.warn({
        event: 'agent.plan.restore.degraded',
        message: 'Agent plan restoration degraded',
        context: { scope: 'agent.plan' },
        error,
      });
    }
  }

  contributeTools(builder: ToolContextBuilder): void {
    builder
      .setPlan({
        setCurrentPlanId: (planId) => this.setCurrentPlanId(planId),
        exitPlan: () => this.exitPlan(),
      })
      .setTaskBoard({ set: (taskBoard) => this.setTaskBoard(taskBoard) });
  }

  setMode(mode: AgentModeId): void {
    if (mode === this.modeId) return;

    if (mode === 'plan') {
      this.returnModeId = this.modeId;
    } else {
      this.returnModeId = null;
    }
    this.applyMode(mode);
  }

  exitPlan(): void {
    if (this.modeId !== 'plan') return;

    const target = this.returnModeId ?? 'normal';
    this.returnModeId = null;
    this.applyMode(target);
  }

  private applyMode(mode: AgentModeId): void {
    this.modeId = mode;

    this.host.emitStateChange();
  }

  getMode(): AgentModeId {
    return this.modeId;
  }

  setCurrentPlanId(planId: string | null): void {
    this.currentPlanId = planId;
  }

  getCurrentPlanId(): string | null {
    return this.currentPlanId;
  }

  /** task 写盘后同步内存镜像并推送状态。 */
  setTaskBoard(taskBoard: TaskBoardState | null): void {
    this.taskBoard = taskBoard;
    this.host.emitStateChange();
  }

  getTaskBoard(): TaskBoardState | null {
    return this.taskBoard;
  }
}
