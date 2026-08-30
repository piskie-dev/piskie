/** TaskTool - Main replaces the global board; Workers replace only their owner scope. */

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

由你执行的任务使用自己的 agent_id。待委派且尚无 Worker 负责的任务使用 owner=null、status=pending；创建 Worker 时通过 taskIds 指定这些任务，之后由 Worker 自行认领。owner 只能使用系统已经提供的真实 Agent ID。

首次创建看板可直接调用。修改已有看板前先调用 task_read 获取最新任务状态。

用户提出后续执行要求时，根据最新要求和 task_read 结果重新确定当前全部未完成任务，并将其完整提交到 items。`;

const WORKER_DESCRIPTION = `维护你负责的 Task Board 项。任务范围、状态、依赖或责任人变化时直接提交；计划尚未获批时不能写入。

初始 <task_board> 中 assigned_here=true 的任务可由你认领；认领时把 owner 设为你自己的 agent_id。assigned_here=true 并被你认领的任务，以及由你新建并负责的任务，属于你；无权修改或使用其他 task。

items 表示你责任范围写入后的最终状态。提交当前属于你的全部任务，以及本次认领或转交的任务。当前属于你的任务未提交表示删除；其他任务由系统保留。新增任务必须使用看板中尚未出现的 ID。`;

const taskItemSchema = z.object({
  id: z.string().describe('看板内稳定且唯一的逻辑任务 ID'),
  subject: z.string().describe('短而具体的可交付成果名称'),
  description: z.string().describe('单项范围、产出、验收与必要交接事实'),
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
    scope: 'shared',
    effects: [],
    schema: taskSchema,
    description: (agentType) => agentType === 'worker' ? WORKER_DESCRIPTION : MAIN_DESCRIPTION,
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

    const isWorker = context.agentType === 'worker';
    if (!isWorker && params.taskSummary !== undefined && typeof params.taskSummary !== 'string') {
      return this.error('taskSummary 必须是字符串');
    }

    const snapshot = context.assignmentSnapshot;
    const assignmentOwners = new Map(
      snapshot?.items
        .filter((item) => item.assignedHere)
        .map((item) => [item.id, item.owner] as const) ?? [],
    );

    try {
      const { board, affectedWorkers } = await taskBoardService.syncTaskBoard({
        mainAgentId,
        callerAgentId: context.agentId,
        taskSummary: !isWorker && typeof params.taskSummary === 'string' ? params.taskSummary : undefined,
        items: params.items as TaskItem[],
        activeWorkerIds: !isWorker ? context.events?.allowedTargets() ?? [] : undefined,
        assignmentOwners,
      });
      this.publishTaskBoard(board, context);

      const relevantItems = this.selectRelevantItems(board, context, params.items as TaskItem[]);
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
          items: relevantItems,
          progress,
          ...(affectedWorkers.length > 0 ? { affectedWorkers } : {}),
        },
      );
    } catch (error) {
      if (error instanceof TaskBoardError) {
        if (error.currentBoard) this.publishTaskBoard(error.currentBoard, context);
        const relevantBoard = error.code !== 'read_required' && error.currentBoard
          ? {
              ...error.currentBoard,
              items: this.selectRelevantItems(error.currentBoard, context, params.items as TaskItem[]),
            }
          : undefined;
        return this.error(error.message, {
            code: error.code,
            ...(relevantBoard ? { taskBoard: relevantBoard } : {}),
          });
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`Task Board 同步失败: ${message}`);
    }
  }

  private publishTaskBoard(board: TaskBoardData, context: ToolContext): void {
    context.taskBoard?.set({ taskSummary: board.taskSummary, items: board.items });
  }

  private selectRelevantItems(
    board: TaskBoardData,
    context: ToolContext,
    submittedItems: TaskItem[],
  ): TaskItem[] {
    if (context.agentType === 'main') return board.items;
    const subagentConfig = context.subagentConfig;
    const relevantIds = new Set([
      ...(subagentConfig?.taskIds ?? []),
      ...submittedItems.map((item) => item.id),
    ]);
    return board.items.filter((item) => item.owner === context.agentId || relevantIds.has(item.id));
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
