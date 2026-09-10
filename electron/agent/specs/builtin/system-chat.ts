import type { AgentSpec } from '../spec.js';
import { WORKSPACE_TOOL_NAMES } from '../native-tool-sets.js';
import { assemble, directorIdentity } from '../../prompts/index.js';

/** 系统级对话助手：用于快速聊天入口，基于 director 但对话风格 */
export const systemChatSpec: AgentSpec = {
  name: 'system-chat',
  role: 'director',
  tools: {
    sdkGroups: [],
    customTools: ['web_search', ...WORKSPACE_TOOL_NAMES, 'subagent', 'subagent_stop', 'send_event', 'plan', 'task_read', 'task', 'ask_user', 'generate_image', 'agent_run', 'load_skill', 'skill_call'],
  },
  buildSystemPrompt: (ctx) => assemble(directorIdentity, ctx),
  modules: ['subagent', 'image', 'plan'],
};
