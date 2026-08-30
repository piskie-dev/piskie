/**
 * SkillCallTool - 已安装技能函数的统一调用入口
 *
 * 技能函数不注入工具列表（工具面在 agent 生命周期内恒定），全部经本工具调用。
 * Coordinator 会先把选择器精确解析为已发布函数，再进入统一 zod/policy 执行链。
 * 自愈闭环：函数名错回显函数清单，参数校验失败回显该函数 schema——错误即文档。
 */

import { BaseTool } from '../base-tool.js';
import type {
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';
import { z } from '../params.js';
import { InvariantViolation } from '../pipeline/invariant-violation.js';

const skillCallSchema = z.object({
  skill: z.string().min(1).describe('Skill 使用说明中的准确名称'),
  function: z.string().min(1).describe('Skill 使用说明列出的公开函数名'),
  args: z.record(z.string(), z.unknown()).optional()
    .describe('函数签名列出的业务参数'),
});
export type SkillCallParams = z.infer<typeof skillCallSchema>;

export class SkillCallTool extends BaseTool<SkillCallParams> {
  readonly def: ToolDef<SkillCallParams> = {
    name: 'skill_call',
    scope: 'shared',
    effects: [],
    schema: skillCallSchema,
    description: '调用 Skill 使用说明中指定通过本工具执行的公开函数。' +
      'skill、function 和 args 必须与说明中的 Skill 名称、函数名和参数签名一致。',
  };

  async execute(
    _params: SkillCallParams,
    _context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    throw new InvariantViolation('skill_call must be resolved before PREPARE');
  }
}
