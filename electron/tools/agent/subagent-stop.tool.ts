import { BaseTool } from '../base-tool.js';
import type { ToolContext, ToolDef } from '../types.js';
import { z } from '../params.js';

export const subagentStopSchema = z.strictObject({
  subagentId: z.string().trim().min(1).describe('创建结果返回的完整 subagentId，不接受序号'),
});

export type SubagentStopParams = z.infer<typeof subagentStopSchema>;

export class SubagentStopTool extends BaseTool<SubagentStopParams> {
  readonly def: ToolDef<SubagentStopParams> = {
    name: 'subagent_stop', scope: 'main', effects: ['agent-control'], schema: subagentStopSchema,
    description: '提前终止卡死或不再需要的 Worker。需要接管它的工作时，先停止再创建新 Worker。',
  };

  async execute(params: SubagentStopParams, context: ToolContext) {
    if (!context.subagents) return this.error('子流程服务不可用');
    try {
      await context.subagents.destroy(params.subagentId);
      return this.success(`子流程已终止: ${params.subagentId}`);
    } catch (error) {
      return this.error(`终止子流程失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
