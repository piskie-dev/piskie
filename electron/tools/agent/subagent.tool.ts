/**
 * SubagentTool - 子流程委派工具
 *
 * action 收窄为 create/stop：常规回收归系统（spec lifecycle，见 subagent.module.ts），
 * stop 只用于提前终止。mode/agentType 合并为单参数 type。
 */

import { BaseTool } from '../base-tool.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { z } from '../params.js';
import type {
  AssignmentTaskBoardSnapshot,
  SubagentMode,
  ToolInputSchema,
} from '../../../shared/types/index.js';
import { browserEnvironmentRuntime } from '../../services/browser-environment-runtime.js';
import { TaskBoardError, taskBoardService } from '../../agent-runs/task-board-service.js';

const BASE_TYPES = new Set(['browser', 'local']);
const BASE_TYPE_DESCRIPTIONS = Object.freeze([
  { name: 'browser', mode: 'browser' as const, description: '操作网站的通用浏览器 Worker' },
  { name: 'local', mode: 'local' as const, description: '处理本地文件和命令的通用 Worker' },
]);

const optionalString = (description: string, maxLength?: number) =>
  (maxLength === undefined ? z.string().trim().min(1) : z.string().trim().min(1).max(maxLength))
    .optional()
    .describe(description);

const subagentSchema = z
  .object({
    action: z
      .enum(['create', 'stop'])
      .describe('操作类型：create 创建 Worker；stop 提前终止 Worker'),
    type: optionalString(
      'create 必填。必须从当前工具 Schema 列出的 Worker type 中选择，不得猜测名称'
    ),
    subject: optionalString('整个 Assignment 的简短显示标题（create 必填，trim 后 1-40 字符）', 40),
    taskIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, 'taskIds 不能包含重复 ID')
      .optional()
      .describe('本次 Assignment 包含的一个或多个当前 Task Board 细任务 ID（create 必填）'),
    prompt: optionalString('完整、自包含的任务简报（create 必填）'),
    skills: z
      .array(z.string())
      .optional()
      .describe(
        '需要加载的 Skill 名称列表（可选），取自 <available_skills> 或 tool_search 返回结果'
      ),
    browserEnvironmentId: optionalString(
      'type=browser 且绑定了浏览器环境池时必填；必须是池中的真实环境 ID（清单见文末 <browser_environments>）'
    ),
    subagentId: optionalString('要终止的完整子流程 ID（action=stop 时必填，不接受序号）'),
  })
  .superRefine((params, issue) => {
    if (params.action === 'create') {
      for (const field of ['type', 'subject', 'taskIds', 'prompt'] as const) {
        if (params[field] === undefined) {
          issue.addIssue({
            code: 'custom',
            path: [field],
            message: `action=create 时需要提供 ${field}`,
          });
        }
      }
    } else if (params.subagentId === undefined) {
      issue.addIssue({
        code: 'custom',
        path: ['subagentId'],
        message: 'action=stop 时需要提供 subagentId',
      });
    }
  });
type SubagentParams = z.infer<typeof subagentSchema>;
type CreateSubagentParams = SubagentParams & {
  action: 'create';
  type: string;
  subject: string;
  taskIds: string[];
  prompt: string;
};
type StopSubagentParams = SubagentParams & { action: 'stop'; subagentId: string };

function withAvailableWorkerTypes(
  schema: ToolInputSchema,
  namedTypes: readonly { name: string; description: string; mode: SubagentMode }[],
  resources: Readonly<{
    browserEnvironmentIds: readonly string[];
  }>
): ToolInputSchema {
  const allTypes = [...BASE_TYPE_DESCRIPTIONS, ...namedTypes];
  const typeSchema = schema.properties.type;
  if (!typeSchema || typeof typeSchema !== 'object' || Array.isArray(typeSchema)) return schema;
  const typeNames = (mode: SubagentMode) =>
    allTypes.filter((type) => type.mode === mode).map((type) => type.name);
  const commonCreateProperties = {
    action: { const: 'create' },
    subject: {},
    taskIds: {},
    prompt: {},
    skills: {},
  };
  const createBranch = (mode: SubagentMode, resourceProperty?: 'browserEnvironmentId') => ({
    properties: {
      ...commonCreateProperties,
      type: { enum: typeNames(mode) },
      ...(resourceProperty ? { [resourceProperty]: {} } : {}),
    },
    required: [
      'action',
      'type',
      'subject',
      'taskIds',
      'prompt',
      ...(resourceProperty ? [resourceProperty] : []),
    ],
    additionalProperties: false,
  });
  const properties = {
    ...schema.properties,
    type: {
      ...typeSchema,
      enum: allTypes.map((type) => type.name),
      description: [
        'action=create 时必填，必须使用以下精确值，不得自行改名：',
        ...allTypes.map((type) => `- ${type.name}：${type.description}`),
      ].join('\n'),
    },
    ...(resources.browserEnvironmentIds.length > 0
      ? {
          browserEnvironmentId: {
            ...(schema.properties.browserEnvironmentId as Record<string, unknown>),
            enum: [...resources.browserEnvironmentIds],
          },
        }
      : {}),
  };
  if (resources.browserEnvironmentIds.length === 0) delete properties.browserEnvironmentId;

  return {
    ...schema,
    properties,
    required: ['action'],
    oneOf: [
      createBranch('local'),
      createBranch(
        'browser',
        resources.browserEnvironmentIds.length > 0 ? 'browserEnvironmentId' : undefined
      ),
      {
        properties: {
          action: { const: 'stop' },
          subagentId: {},
        },
        required: ['action', 'subagentId'],
        additionalProperties: false,
      },
    ],
  };
}

export class SubagentTool extends BaseTool<SubagentParams> {
  readonly def: ToolDef<SubagentParams> = {
    name: 'subagent',
    scope: 'main',
    effects: ['agent-control'],
    schema: subagentSchema,
    modelInputSchema: (schema, context) =>
      withAvailableWorkerTypes(schema, context.subagentTypes, context.subagentResources),
    description: `创建 Worker 执行边界清晰的独立 Assignment，或提前终止仍在运行的 Worker。subject
使用具体的工作包名称；一个 browser Worker 只负责一个网站或一段连续的业务上下文。

## 编写 prompt

把新的 Worker 当作一位刚走进房间的聪明同事来交接：它能力完整，可以自主判断，但不知道当前对话
和既有进展。prompt 应完整、自包含，并包含：

- 目标、范围和可观察结果；
- 已知、尝试过和已排除的事实；
- 安全边界与用户约束；
- 所需文件路径、网站入口和环境标识；
- 期望产出、验证标准和需要回报的关键事实；
- 多项任务之间的边界、依赖和顺序。

一次响应可以并行创建多个互不冲突的 Assignment。

action=stop 只用于提前终止卡死或不再需要的 Worker，并传入创建结果返回的完整 subagentId。`,
  };

  async execute(params: SubagentParams, context: ToolContext): Promise<ToolOutput<unknown>> {
    const action = params.action;

    if (action === 'create') {
      return this.createSubagent(params as CreateSubagentParams, context);
    } else if (action === 'stop') {
      return this.stopSubagent(params as StopSubagentParams, context);
    } else {
      return this.error(`未知的操作类型: ${action}（可用: create / stop）`);
    }
  }

  /** 基础类型不需要查 AgentSpec；专属类型由当前 Director 的 SubagentPort 授权。 */
  private resolveBaseType(
    type: string | undefined
  ): { mode: SubagentMode } | { customType: string } | { error: string } {
    const value = type?.trim();
    if (!value) return { error: '创建 Worker 需要提供 type' };
    if (BASE_TYPES.has(value)) {
      return { mode: value as SubagentMode };
    }
    return { customType: value };
  }

  /**
   * 创建子流程
   */
  private async createSubagent(
    params: CreateSubagentParams,
    context: ToolContext
  ): Promise<ToolOutput<unknown>> {
    const base = this.resolveBaseType(params.type);
    if ('error' in base) return this.error(base.error);
    if (!context.subagents) return this.error('createSubagent 回调未配置');
    const resolved: { mode: SubagentMode; agentSpec?: string } | { error: string } =
      'customType' in base ? context.subagents.resolveType(base.customType) : { mode: base.mode };
    if ('error' in resolved) return this.error(resolved.error);
    const mode = resolved.mode;
    const agentSpec = resolved.agentSpec;
    const { skills, subject, prompt } = params;
    const browserEnvironmentId = params.browserEnvironmentId?.trim();

    if (!subject) {
      return this.error('创建 Worker 需要提供非空 subject');
    }
    if (subject.length > 40) {
      return this.error('subject 最多 40 个字符');
    }
    if (!prompt.trim()) {
      return this.error('创建 Worker 需要提供完整 prompt');
    }
    const taskIds = params.taskIds;

    const environmentValidationError = this.validateBrowserEnvironment(
      mode,
      browserEnvironmentId,
      context
    );
    if (environmentValidationError) return environmentValidationError;

    const mainAgentId = context.mainAgentId;

    let taskBoardSnapshot: AssignmentTaskBoardSnapshot;
    try {
      taskBoardSnapshot = await taskBoardService.createCompactSnapshot(mainAgentId, taskIds);
    } catch (error) {
      if (error instanceof TaskBoardError) return this.error(error.message);
      return this.error(
        `读取 Task Board 失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const subagentId = await context.subagents.create(
        {
          mode,
          subject,
          taskIds,
          prompt,
          skills,
          ...(browserEnvironmentId ? { browserEnvironmentId } : {}),
          ...(agentSpec ? { agentSpec } : {}),
        },
        taskBoardSnapshot
      );

      // 立即返回创建成功；trace 只用于按需诊断，正常进度由事件通知。
      const traceFile = context.subagents.traceFilePath(subagentId);
      const traceHint = traceFile
        ? `\n执行流水: ${traceFile}（仅在用户主动查询进度或怀疑 Worker 卡住时用 read 读取；正常执行会通过事件通知，无需轮询）`
        : '';
      return this.success(
        `Worker 已按要求创建: ${subject}\nsubagentId: ${subagentId}${traceHint}`,
        {
          subagentId,
          subject,
          taskIds,
          type: params.type,
          ...(browserEnvironmentId ? { browserEnvironmentId } : {}),
        }
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.error(`创建子流程失败: ${errorMsg}`);
    }
  }

  private validateBrowserEnvironment(
    mode: SubagentMode,
    browserEnvironmentId: string | undefined,
    context: ToolContext
  ): ToolOutput<unknown> | null {
    const boundEnvironmentIds = this.readBoundBrowserPool(context);

    if (mode !== 'browser') {
      return browserEnvironmentId
        ? this.error('browserEnvironmentId 只能用于 type=browser 的子流程')
        : null;
    }
    if (boundEnvironmentIds.length === 0) {
      return browserEnvironmentId
        ? this.error(
            '当前未绑定浏览器环境池，不能指定 browserEnvironmentId；请在 Console 绑定环境后重新启动'
          )
        : null;
    }
    if (!browserEnvironmentId) {
      return this.error(
        `已绑定浏览器环境池，创建 browser 子流程必须提供 browserEnvironmentId。可用环境：${boundEnvironmentIds.join(', ')}`
      );
    }
    if (!boundEnvironmentIds.includes(browserEnvironmentId)) {
      return this.error(
        `环境 ${browserEnvironmentId} 不在绑定的浏览器环境池中。只能使用：${boundEnvironmentIds.join(', ')}`
      );
    }
    if (!browserEnvironmentRuntime.getEnvironment(browserEnvironmentId)) {
      return this.error(`绑定的浏览器环境不存在或已被删除: ${browserEnvironmentId}`);
    }
    return null;
  }

  private readBoundBrowserPool(context: ToolContext): string[] {
    const bindings = context.runConfig.bindings;
    if (bindings?.type !== 'standard' || !Array.isArray(bindings.boundEnvironmentIds)) return [];

    const environmentIds: string[] = [];
    for (const candidate of bindings.boundEnvironmentIds) {
      if (typeof candidate === 'string' && candidate.length > 0) environmentIds.push(candidate);
    }
    return environmentIds;
  }

  /**
   * 提前终止子流程
   */
  private async stopSubagent(
    params: StopSubagentParams,
    context: ToolContext
  ): Promise<ToolOutput<unknown>> {
    const subagentId = params.subagentId;

    if (!subagentId) {
      return this.error('终止子流程需要提供 subagentId 参数');
    }

    if (!context.subagents) {
      return this.error('destroySubagent 回调未配置');
    }

    try {
      await context.subagents.destroy(subagentId);
      return this.success(`子流程已终止: ${subagentId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.error(`终止子流程失败: ${errorMsg}`);
    }
  }
}
