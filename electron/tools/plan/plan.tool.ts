/**
 * PlanTool - 计划文档（plan/task 双装置拆分）
 *
 * plan = 计划正文（markdown 散文）；执行期 Task Board 归 task 工具。
 * create 在任意运行模式下都可提交，且一律强制审批（在 pipeline 拦截链实现）；
 * read 全模式可用（resume 后找回当前计划）。每次 create 都是新计划文件，历史永久保留。
 */

import { BaseTool } from '../base-tool.js';
import type {
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';
import { z } from '../params.js';
import { planRepository } from '../../agent-runs/plan-repository.js';

const planSchema = z.object({
  action: z.enum(['create', 'read']).describe('操作类型'),
  taskSummary: z.string().trim().min(1)
    .optional()
    .describe('[create] 任务摘要和计划标题'),
  planDocument: z.string().trim().min(1)
    .optional()
    .describe('[create] 提交审批的完整 Markdown 计划正文'),
}).superRefine((params, context) => {
  if (params.action === 'create' && params.taskSummary === undefined) {
    context.addIssue({ code: 'custom', path: ['taskSummary'], message: 'create 需要 taskSummary' });
  }
  if (params.action === 'create' && params.planDocument === undefined) {
    context.addIssue({ code: 'custom', path: ['planDocument'], message: 'create 需要 planDocument' });
  }
  if (params.action === 'read' && params.taskSummary !== undefined) {
    context.addIssue({ code: 'custom', path: ['taskSummary'], message: 'read 不接受 taskSummary' });
  }
  if (params.action === 'read' && params.planDocument !== undefined) {
    context.addIssue({ code: 'custom', path: ['planDocument'], message: 'read 不接受 planDocument' });
  }
}).meta({
  oneOf: [
    {
      properties: {
        action: { const: 'create' },
        taskSummary: { type: 'string', minLength: 1 },
        planDocument: { type: 'string', minLength: 1 },
      },
      required: ['action', 'taskSummary', 'planDocument'],
      additionalProperties: false,
    },
    {
      properties: { action: { const: 'read' } },
      required: ['action'],
      additionalProperties: false,
    },
  ],
});
type PlanParams = z.infer<typeof planSchema>;

export class PlanTool extends BaseTool<PlanParams> {
  readonly def: ToolDef<PlanParams> = {
    name: 'plan',
    scope: 'main',
    effects: [],
    schema: planSchema,
    description: `维护计划文档。create 提交完整计划给用户审批；read 读取当前计划信息。create 成功表示计划已获批准，随后建立 Task Board 并立即执行。

计划正文包含：
- 目标与范围；
- 关键决策及理由；
- 执行方案；
- 成功判据。

只提前确定会影响范围、实现方向或安全边界的关键决策；实现细节在执行时根据事实判断。已经查证的事实写成结论，尚未确认的事实明确写成假设。可查证的事实先使用可用的只读工具调查；只有用户偏好或方案取舍需要用户决定时才询问。

用户要求修改计划时，结合原目标和反馈重新提交一份完整计划，不只提交增量内容。

通用正文模板：
\`\`\`markdown
## 目标与范围
说明要达成的结果、包含内容和边界。

## 关键决策及理由
列出影响方向或安全边界的决定及依据。

## 执行方案
说明实施顺序、依赖和验证方式。

## 成功判据
列出可观察、可验证的完成条件。
\`\`\``,
  };

  async execute(
    params: PlanParams,
    context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    const action = params.action;

    const agentId = context.agentId;
    if (!agentId) {
      return this.error('无法获取 Agent ID');
    }

    const mainAgentId = context.mainAgentId;

    switch (action) {
      case 'create':
        return this.createPlan(params, mainAgentId, context);
      case 'read':
        return this.readPlan(mainAgentId);
      default:
        return this.error(`未知操作: ${action}`);
    }
  }

  private async createPlan(
    params: PlanParams,
    mainAgentId: string,
    context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    const taskSummary = params.taskSummary;
    if (!taskSummary) {
      return this.error('创建计划需要: taskSummary');
    }

    const planDocument = params.planDocument;
    if (typeof planDocument !== 'string' || !planDocument.trim()) {
      return this.error('创建计划需要: planDocument（Markdown 计划正文，按"目标与范围/关键决策及理由/执行方案/成功判据"组织）');
    }


    try {
      const { planId, documentPath } = await planRepository.createPlan(mainAgentId, taskSummary, planDocument);

      // 设置当前计划 ID（供 MainAgent 追踪；指针已由 PlanRepository 落盘）
      context.plan?.setCurrentPlanId(planId);
      context.plan?.exitPlan();

      return this.success(
        `计划已获批准 (ID: ${planId})，正文位于 ${documentPath}。建立 Task Board 并开始执行`,
        { planId, taskSummary, documentPath }
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.error(`创建失败: ${errorMsg}`);
    }
  }

  private async readPlan(mainAgentId: string): Promise<ToolOutput<unknown>> {
    try {
      const meta = await planRepository.readCurrentPlan(mainAgentId);
      if (!meta) {
        return this.error('当前没有计划（可用 create 提交计划审批）');
      }
      return this.success(
        `当前计划: ${meta.taskSummary} (ID: ${meta.planId})，正文见 ${meta.documentPath}`,
        meta as unknown as Record<string, unknown>
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.error(`读取失败: ${errorMsg}`);
    }
  }
}
