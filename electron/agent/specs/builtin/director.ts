import type { AgentSpec } from '../spec.js';
import { WORKSPACE_TOOL_NAMES } from '../native-tool-sets.js';
import { assemble, directorIdentity } from '../../prompts/index.js';

/** 协调者：创建和管理多个子任务，协调复杂工作流 */
export const directorSpec: AgentSpec = {
  name: 'director',
  role: 'director',
  tools: {
    sdkGroups: [],
    customTools: [...WORKSPACE_TOOL_NAMES, 'subagent', 'send_event', 'plan', 'task_read', 'task', 'ask_user', 'generate_image', 'agent_run'],
  },
  buildSystemPrompt: (ctx) => assemble(directorIdentity, ctx),
  modules: ['subagent', 'image', 'plan'],
};
