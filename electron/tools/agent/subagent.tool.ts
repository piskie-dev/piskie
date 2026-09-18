import { BaseTool } from '../base-tool.js';
import type { SubagentTypeDescriptor, ToolContext, ToolDef } from '../types.js';
import { createSubagentSchema, subagentSchema, type SubagentParams } from './subagent-contract.js';
import { handoffGuidance } from './handoff.js';

const OPENING = `创建 Worker 承接一个工作包或一个检索问题。subject 是给用户看的短标题。`;
const HANDOFF = handoffGuidance(' Worker ', 'prompt');
const DESCRIPTION = `${OPENING}

${HANDOFF}`;

/** Worker 类型清单渲染在工具正文里（模型选工具时读到），type 参数只保留指针。 */
function describeSubagent(types: readonly SubagentTypeDescriptor[]): string {
  const typeList = types.length
    ? `可用的 Worker 类型：\n${types.map((type) => `- ${type.name}：${type.description}`).join('\n')}`
    : '';
  return [OPENING, typeList, HANDOFF].filter(Boolean).join('\n\n');
}

export class SubagentTool extends BaseTool<SubagentParams> {
  readonly def: ToolDef<SubagentParams> = {
    name: 'subagent', scope: 'main', effects: ['agent-control'], schema: subagentSchema,
    description: DESCRIPTION,
    resolveContract: (_options, context) => ({
      schema: createSubagentSchema(context.subagentTypes, context.subagentResources.browserEnvironmentIds),
      description: describeSubagent(context.subagentTypes),
    }),
  };

  async execute(params: SubagentParams, context: ToolContext) {
    if (!context.subagents) return this.error('子流程服务不可用');
    try {
      const config = {
        type: params.type, subject: params.subject, prompt: params.prompt,
        ...(params.skills ? { skills: params.skills } : {}),
        ...(params.browserEnvironmentId ? { browserEnvironmentId: params.browserEnvironmentId } : {}),
      };
      const subagentId = await context.subagents.create(config);
      const traceFile = context.subagents.traceFilePath(subagentId);
      const traceHint = traceFile
        ? `\n执行流水: ${traceFile}（仅在用户主动查询进度或怀疑 Worker 卡住时用 read 读取；正常执行会通过事件通知，无需轮询）`
        : '';
      return this.success(`Worker 已按要求创建: ${params.subject}\nsubagentId: ${subagentId}${traceHint}`, {
        subagentId, subject: config.subject, type: config.type,
        ...(config.browserEnvironmentId ? { browserEnvironmentId: config.browserEnvironmentId } : {}),
      });
    } catch (error) {
      return this.error(`创建子流程失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
