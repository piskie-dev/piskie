import { BaseTool } from '../base-tool.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { z } from '../params.js';
import { createDirectorRunConfig } from '../../agent/launch/agent-run-config-factory.js';
import { directorSpec } from '../../agent/specs/builtin/director.js';
import { agentRunTraceService } from '../../agent-runs/agent-run-trace-service.js';
import { agentService } from '../../services/agent.service.js';

const agentRunSchema = z
  .object({
    action: z.enum(['create', 'list', 'stop']).describe('操作类型'),
    taskDescription: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('[create] 新顶层智能体的完整、自包含任务描述'),
    agentId: z.string().trim().min(1).optional().describe('[stop] 要停止的顶层 Agent ID'),
  })
  .superRefine((params, context) => {
    if (params.action === 'create' && params.taskDescription === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['taskDescription'],
        message: 'create 需要 taskDescription',
      });
    }
    if (params.action === 'stop' && params.agentId === undefined) {
      context.addIssue({ code: 'custom', path: ['agentId'], message: 'stop 需要 agentId' });
    }
    if (params.action !== 'create' && params.taskDescription !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['taskDescription'],
        message: `${params.action} 不接受 taskDescription`,
      });
    }
    if (params.action !== 'stop' && params.agentId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['agentId'],
        message: `${params.action} 不接受 agentId`,
      });
    }
  })
  .meta({
    oneOf: [
      {
        properties: {
          action: { const: 'create' },
          taskDescription: { type: 'string', minLength: 1 },
        },
        required: ['action', 'taskDescription'],
        additionalProperties: false,
      },
      {
        properties: { action: { const: 'list' } },
        required: ['action'],
        additionalProperties: false,
      },
      {
        properties: {
          action: { const: 'stop' },
          agentId: { type: 'string', minLength: 1 },
        },
        required: ['action', 'agentId'],
        additionalProperties: false,
      },
    ],
  });
type AgentRunParams = z.infer<typeof agentRunSchema>;

export class AgentRunTool extends BaseTool<AgentRunParams> {
  readonly def: ToolDef<AgentRunParams> = {
    name: 'agent_run',
    scope: 'main',
    effects: ['agent-control'],
    schema: agentRunSchema,
    description: `创建和管理其他顶层智能体。

- create：仅当用户明确要求启动另一套独立的顶层任务时使用。该任务不能依赖当前会话持续协调，也不能与当前任务争用同一独占浏览器环境。当前任务内的分工或并行加速使用 subagent。
- list：查看顶层智能体的运行状态和最近动态。
- stop：发起停止指定顶层智能体；需要确认是否已经停止时再用 list 检查。

新顶层智能体不向当前会话汇报，也不随当前智能体结束而自动停止。

## 编写 taskDescription

把新的顶层智能体当作一位刚走进房间的聪明同事来交接：它能力完整，可以自主判断，但不知道当前对话和既有进展。taskDescription 应完整、自包含，并包含：

- 独立任务的目标、范围和可观察结果；
- 已知、尝试过和已排除的事实；
- 安全边界与用户约束；
- 所需网站入口、文件路径和环境标识；
- 期望产出、验证标准和结果去向。

边界示例：用户明确要求在当前任务之外另行运行一项独立工作时使用 agent_run；把当前任务拆成多个协作工作包时使用 subagent。`,
  };

  async execute(params: AgentRunParams, context: ToolContext): Promise<ToolOutput<unknown>> {
    if (params.action === 'create') return this.create(params, context);
    if (params.action === 'list') return this.list();
    if (params.action === 'stop') return this.stop(params, context);
    return this.error('未知操作；可用: create / list / stop');
  }

  private async create(
    params: AgentRunParams,
    context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    const taskDescription = params.taskDescription;
    if (!taskDescription) return this.error('创建顶层智能体需要 taskDescription');

    const inheritedModeId = context.modes.modeId();
    const initialModeId = inheritedModeId === 'plan' ? 'plan' : 'normal';
    const runConfig = createDirectorRunConfig(taskDescription, {
      workspace: context.runConfig.workspace,
      bindings: context.runConfig.bindings,
      advancedSettings: context.runConfig.advancedSettings,
      mcpServers: context.runConfig.mcpServers,
    });

    try {
      const state = await agentService.startAgent({
        runConfig,
        agentSpec: directorSpec,
        initialModeId,
        initialApprovalMode: context.modes.approvalMode(),
        launchOptions: { initialModel: context.currentModel },
      });
      const tracePath = agentRunTraceService.tracePath(state.agentId);
      return this.success(`顶层智能体已创建: ${state.agentId}\n运行流水: ${tracePath}`, {
        agentId: state.agentId,
        taskDescription,
        tracePath,
      });
    } catch (error) {
      return this.error(
        `创建顶层智能体失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async list(): Promise<ToolOutput<unknown>> {
    try {
      const traces = new Map(
        (await agentRunTraceService.list()).map((trace) => [trace.agentId, trace] as const)
      );
      const runs = agentService
        .getConversationStore()
        .scanHeaders()
        .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
        .map((header) => {
          const trace = traces.get(header.agentId);
          return {
            agentId: header.agentId,
            name: header.runConfig.name,
            status: agentService.hasAgentInMemory(header.agentId) ? 'active' : 'stopped',
            recentTail: trace?.recentTail ?? '',
            tracePath: trace?.tracePath,
          };
        });
      return this.success(
        runs.length > 0
          ? runs
              .map(
                (run) =>
                  `${run.status === 'active' ? '活跃' : '已停'} · ${run.agentId} · ${run.name}\n` +
                  `最近动态: ${run.recentTail || '（暂无执行流水）'}` +
                  (run.tracePath ? `\n完整流水: ${run.tracePath}` : '')
              )
              .join('\n\n')
          : '暂无顶层智能体记录',
        { runs }
      );
    } catch (error) {
      return this.error(
        `列出顶层智能体失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async stop(
    params: AgentRunParams,
    context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    const agentId = params.agentId;
    if (!agentId) return this.error('停止顶层智能体需要 agentId');
    if (agentId === context.mainAgentId) return this.error('不能停止你自己');
    if (!agentService.hasAgentInMemory(agentId)) {
      return this.error(`顶层智能体不存在或已经停止: ${agentId}`);
    }

    void agentService.stopAgent(agentId).catch(() => undefined);
    return this.success(`已发起停止顶层智能体: ${agentId}（停止在后台异步完成）`, {
      agentId,
      status: 'stopping',
    });
  }
}
