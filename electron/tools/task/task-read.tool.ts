/** Read-only Main tool for observing the latest Task Board. */

import { BaseTool } from '../base-tool.js';
import type {
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';
import { z } from '../params.js';
import { TaskBoardError, taskBoardService } from '../../agent-runs/task-board-service.js';
import type { TaskBoardData, TaskItem } from '../../../shared/types/index.js';

// TaskBoardService enforces the pre-write read requirement.
const DESCRIPTION = '读取当前执行范围的 Task Board。在修改已有看板前调用。';

const taskReadSchema = z.object({});
type TaskReadParams = z.infer<typeof taskReadSchema>;

export class TaskReadTool extends BaseTool<TaskReadParams> {
  readonly def: ToolDef<TaskReadParams> = {
    name: 'task_read',
    scope: 'main',
    effects: [],
    schema: taskReadSchema,
    description: DESCRIPTION,
  };

  async execute(
    _params: TaskReadParams,
    context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    if (context.agentType !== 'main') return this.error('task_read 仅供 Main 使用');
    if (!context.agentId) return this.error('无法获取 Agent ID');

    const mainAgentId = context.mainAgentId;

    try {
      const board = await taskBoardService.readTaskBoardForMain({
        mainAgentId,
        callerAgentId: context.agentId,
      });
      if (!board) {
        return this.success('当前尚未建立 Task Board', { taskBoard: null });
      }

      this.publishTaskBoard(board, context);
      const progress = this.summarizeProgress(board.items);
      const unfinishedItems = board.items.filter((item) => item.status !== 'completed');
      const completedItems = board.items
        .filter((item) => item.status === 'completed')
        .map(({ id, subject }) => ({ id, subject }));
      return this.success(
        `taskSummary：${JSON.stringify(board.taskSummary)}\n` +
        `当前未完成任务：${JSON.stringify(unfinishedItems)}\n` +
        `已完成任务：${JSON.stringify(completedItems)}`,
        {
          taskSummary: board.taskSummary,
          items: board.items,
          progress,
        },
      );
    } catch (error) {
      if (error instanceof TaskBoardError) return this.error(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`Task Board 读取失败: ${message}`);
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
