import { z, toToolInputSchema } from '../params.js';
import type { SubagentTypeDescriptor } from '../types.js';

const nonempty = z.string().trim().min(1);
const fields = {
  type: nonempty.describe('必须从当前工具 Schema 列出的 Worker type 中选择，不得猜测名称'),
  subject: nonempty.max(40).describe('整个 Assignment 的简短显示标题（trim 后 1-40 字符）'),
  prompt: nonempty.describe('交给 Worker 的任务或问题'),
  skills: z.array(nonempty).describe('需要加载的 Skill 名称列表（可选），取自 <available_skills> 或 tool_search 返回结果'),
  browserEnvironmentId: nonempty.describe('浏览器 Worker 使用的浏览器环境 ID。当前会话已有浏览器环境（文末 <browser_environments> 清单，或用户消息中声明已加入会话的环境）时必填，且必须是其中的真实 ID；会话没有浏览器环境时省略，使用临时浏览器。一个浏览器环境同一时间只能由一个 Worker 使用。同一网站或连续业务的后续任务，优先复用已有 Worker。'),
};

export const subagentSchema = z.strictObject({
  type: fields.type,
  subject: fields.subject,
  prompt: fields.prompt,
  skills: fields.skills.optional(),
  browserEnvironmentId: fields.browserEnvironmentId.optional(),
});

export type SubagentParams = z.infer<typeof subagentSchema>;

/**
 * Each Worker type owns both its model schema and its execution validator.
 * 浏览器环境 ID 在 schema 层只要求是稳定非空字符串；是否属于会话当前集合
 * 由 SubagentModule 在执行时按 Runtime 的实时集合校验（用户可中途加入环境）。
 */
export function createSubagentSchema(types: readonly SubagentTypeDescriptor[]) {
  const branches = new Map(types.map((type) => [type.name, z.strictObject({
    type: z.literal(type.name).describe(type.description),
    subject: fields.subject,
    prompt: fields.prompt,
    ...(type.skills ? { skills: fields.skills.optional() } : {}),
    ...(type.browser ? { browserEnvironmentId: fields.browserEnvironmentId.optional() } : {}),
  })]));
  const branchList = [...branches.values()];
  const always = new Set(['type', 'subject', 'prompt']);
  const visibleFields: Record<string, z.ZodType> = Object.fromEntries(Object.entries(subagentSchema.shape).filter(([name]) => (
    always.has(name) || branchList.some((branch) => name in branch.shape)
  )));
  visibleFields.type = types.length
    ? z.enum(types.map((type) => type.name)).describe('Worker 类型；各类型的用途和工具见工具描述里的清单。')
    : fields.type;
  const schema = z.strictObject(visibleFields).superRefine((params, ctx) => {
    const branch = branches.get(params.type as string);
    if (!branch) {
      ctx.addIssue({
        code: 'custom', path: ['type'],
        message: types.length ? `请选择当前可用类型：${types.map((type) => type.name).join(' / ')}` : '当前没有可创建的 Worker 类型',
      });
      return;
    }
    const result = branch.safeParse(params);
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });
  if (!branchList.length) return schema as typeof subagentSchema;
  return schema.meta({
    oneOf: branchList.map((branch) => {
      const branchSchema = toToolInputSchema(branch);
      return {
        properties: Object.fromEntries(Object.entries(branchSchema.properties).map(([name, field]) => [
          name, name === 'type' ? { const: (field as { const: string }).const } : {},
        ])),
        required: branchSchema.required,
        additionalProperties: false,
      };
    }),
  }) as typeof subagentSchema;
}
