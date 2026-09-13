/** TaskTool - Main replaces the complete Task Board. */

import { BaseTool } from '../base-tool.js';
import type {
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';
import { z } from '../params.js';
import { TaskBoardError, taskBoardService } from '../../agent-runs/task-board-service.js';
import type {
  TaskBoardData,
  TaskItem,
} from '../../../shared/types/index.js';

// Prompt contract anchor: enforcement lives in TaskBoardService.
const MAIN_DESCRIPTION = `维护当前执行范围的 Task Board。需要记录或协调任务范围、状态、依赖和责任人时调用；计划尚未获批时不能写入。

由你执行的任务使用自己的 agent_id。待委派且尚无 Worker 负责的任务使用 owner=null、status=pending。owner 只能使用系统已经提供的真实 Agent ID。

用户提出后续执行要求时，根据最新要求重新确定当前全部未完成任务，并将其完整提交到 items。`;

const taskItemSchema = z.object({
  id: z.string().describe('看板内稳定且唯一的逻辑任务 ID'),
  subject: z.string().describe('短而具体的任务名称'),
  description: z.string().describe('单项目标、预期产出、完成标准与必要交接事实'),
  status: z.enum(['pending', 'in_progress', 'completed'])
    .describe('工作义务的当前进度；同一 owner 同时最多一个任务为 in_progress'),
  owner: z.string().nullable()
    .describe('当前责任 Agent ID；自身使用自己的 agent_id，null 表示未分配'),
  dependsOn: z.array(z.string())
    .describe('前置任务的稳定 ID；无依赖时提交空数组，删除被依赖项前先更新引用'),
});
const taskSchema = z.object({
  taskSummary: z.string().optional()
    .describe('首次建立看板或切换到独立顶层目标时提供的全局标题'),
  items: z.array(taskItemSchema)
    .describe('需要写入的任务数组；同一 ID 表示修改，新 ID 表示新增；提交范围和未提交任务的处理遵循工具说明'),
});
type TaskParams = z.infer<typeof taskSchema>;

export class TaskTool extends BaseTool<TaskParams> {
  readonly def: ToolDef<TaskParams> = {
    name: 'task',
    scope: 'main',
    effects: [],
    schema: taskSchema,
    description: MAIN_DESCRIPTION,
  };

  async execute(
    params: TaskParams,
    context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    if (!context.agentId) return this.error('无法获取 Agent ID');
    if (!Array.isArray(params.items)) return this.error('items 必须是任务数组');

    if (context.modes.modeId() === 'plan') {
      return this.error('计划尚未获批——先用 plan(create) 提交计划正文审批；获批后再建立 Task Board');
    }

    const mainAgentId = context.mainAgentId;

    if (params.taskSummary !== undefined && typeof params.taskSummary !== 'string') {
      return this.error('taskSummary 必须是字符串');
    }

    try {
      const { board, affectedWorkers } = await taskBoardService.syncTaskBoard({
        mainAgentId,
        taskSummary: params.taskSummary,
        items: params.items as TaskItem[],
        activeWorkerIds: context.events?.allowedTargets() ?? [],
        createdWorkerIds: context.subagents?.createdIds() ?? [],
      });
      this.publishTaskBoard(board, context);

      const progress = this.summarizeProgress(board.items);
      const workerNotice = affectedWorkers.length > 0
        ? '\n\n若本次变更包含 Worker 继续执行所需的新信息，且尚未告知对应 Worker，则向其发送更新。' +
          '\n\n受影响 Worker：\n' + affectedWorkers
          .map((worker) => `- ${worker.workerId}（任务：${worker.taskIds.join('、')}）`)
          .join('\n')
        : '';
      return this.success(
        `Task Board 已同步：${progress.completed}/${progress.total} completed，` +
        `${progress.inProgress} in_progress，${progress.pending} pending${workerNotice}`,
        {
          taskSummary: board.taskSummary,
          items: board.items,
          progress,
          ...(affectedWorkers.length > 0 ? { affectedWorkers } : {}),
        },
      );
    } catch (error) {
      if (error instanceof TaskBoardError) {
        if (error.currentBoard) this.publishTaskBoard(error.currentBoard, context);
        return this.error(error.message, {
          code: error.code,
          ...(error.currentBoard ? { taskBoard: error.currentBoard } : {}),
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`Task Board 同步失败: ${message}`);
    }
  }

  private publishTaskBoard(board: TaskBoardData, context: ToolContext): void {
    context.taskBoard?.set({ taskSummary: board.taskSummary, items: board.items });
  }

  private summarizeProgress(items: TaskItem[]) {
    return {
      total: items.length,
      completed: items.filter((item) => item.status === 'completed').length,
      inProgress: items.filter((item) => item.status === 'in_progress').length,
      pending: items.filter((item) => item.status === 'pending').length,
    };
  }
}
