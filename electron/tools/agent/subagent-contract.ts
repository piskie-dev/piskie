import { z, toToolInputSchema } from '../params.js';
import type { SubagentTypeDescriptor } from '../types.js';

const nonempty = z.string().trim().min(1);
const fields = {
  type: nonempty.describe('必须从当前工具 Schema 列出的 Worker type 中选择，不得猜测名称'),
  subject: nonempty.max(40).describe('整个 Assignment 的简短显示标题（trim 后 1-40 字符）'),
  prompt: nonempty.describe('交给 Worker 的任务或问题'),
  taskIds: z.array(nonempty).min(1)
    .refine((ids) => new Set(ids).size === ids.length, 'taskIds 不能包含重复 ID')
    .describe('将本次交给同一 Worker 的全部任务 ID 一并填写。'),
  skills: z.array(nonempty).describe('需要加载的 Skill 名称列表（可选），取自 <available_skills> 或 tool_search 返回结果'),
  browserEnvironmentId: nonempty.describe('浏览器 Worker 且绑定了浏览器环境池时必填；必须是池中的真实环境 ID（清单见文末 <browser_environments>）。一个环境同时只能给一个 Worker，被占用时先 subagent_stop 旧 Worker，否则创建会失败'),
};

export const subagentSchema = z.strictObject({
  type: fields.type,
  subject: fields.subject,
  prompt: fields.prompt,
  taskIds: fields.taskIds.optional(),
  skills: fields.skills.optional(),
  browserEnvironmentId: fields.browserEnvironmentId.optional(),
});

export type SubagentParams = z.infer<typeof subagentSchema>;

/** Each Worker type owns both its model schema and its execution validator. */
export function createSubagentSchema(
  types: readonly SubagentTypeDescriptor[],
  browserEnvironmentIds: readonly string[],
) {
  const branches = new Map(types.map((type) => [type.name, z.strictObject({
    type: z.literal(type.name).describe(type.description),
    subject: fields.subject,
    prompt: fields.prompt,
    ...(type.assignment === 'task-board' ? { taskIds: fields.taskIds } : {}),
    ...(type.skills ? { skills: fields.skills.optional() } : {}),
    ...(type.browser && browserEnvironmentIds.length ? {
      browserEnvironmentId: z.enum(browserEnvironmentIds).describe(fields.browserEnvironmentId.description!),
    } : {}),
  })]));
  const branchList = [...branches.values()];
  const always = new Set(['type', 'subject', 'prompt']);
  const visibleFields: Record<string, z.ZodType> = Object.fromEntries(Object.entries(subagentSchema.shape).filter(([name]) => (
    always.has(name) || branchList.some((branch) => name in branch.shape)
  )));
  visibleFields.type = types.length
    ? z.enum(types.map((type) => type.name)).describe('Worker 类型；各类型的用途和工具见工具描述里的清单。')
    : fields.type;
  if (visibleFields.browserEnvironmentId) {
    visibleFields.browserEnvironmentId = z.enum(browserEnvironmentIds).optional()
      .describe(fields.browserEnvironmentId.description!);
  }
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
