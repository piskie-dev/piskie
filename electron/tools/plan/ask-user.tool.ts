/**
 * AskUserTool - AI 提问工具
 *
 * 仅供 MainAgent 使用，全模式常在。
 * 逻辑上阻断 AI、物理上挂起当前 Pump：校验成功即返回 suspended，
 * 不写 tool_result——答案由未来的用户事件在消费侧配对为本 tool_use 的结果。
 */

import { BaseTool } from '../base-tool.js';
import type {
  ToolContext,
  ToolDef,
  ToolOutput,
  ToolSuspension,
} from '../types.js';
import { askUserSchema } from '../../agent/context/conversation-protocol.js';
import type { z } from '../params.js';

type AskUserParams = z.infer<typeof askUserSchema>;

export class AskUserTool extends BaseTool<AskUserParams> {
  readonly def: ToolDef<AskUserParams> = {
    name: 'ask_user',
    scope: 'main',
    effects: [],
    schema: askUserSchema,
    description: `需要用户补充信息或作出选择才能继续时调用。单独调用，不与其他工具同时调用。多个待回答事项合并到同一次调用的 questions 数组，每个 question 只询问一个事项；问题只写入 questions，不在回复正文中重复。

**示例**：
\`\`\`json
{
  "questions": [
    { "question": "请选择方案", "options": ["方案 A", "方案 B"] },
    { "question": "还有哪些约束？" }
  ]
}
\`\`\``,
  };

  async execute(
    _params: AskUserParams,
    _context: ToolContext,
  ): Promise<ToolOutput<unknown> | ToolSuspension> {

    // 挂起信号：不写结果、不发完成事件，Pump yield，
    // 答案作为普通用户事件由消费侧配对为本 tool_use 的 tool_result
    return { suspended: true, reason: 'user_input' };
  }
}
