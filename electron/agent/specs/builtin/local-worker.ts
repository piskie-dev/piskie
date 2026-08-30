import type { AgentSpec } from '../spec.js';
import { WORKSPACE_TOOL_NAMES } from '../native-tool-sets.js';
import { assemble, workerIdentity } from '../../prompts/index.js';

/** 本地工作者：对应 sub local 模式 */
export const localWorkerSpec: AgentSpec = {
  name: 'local-worker',
  role: 'worker',
  tools: {
    sdkGroups: [],
    customTools: [...WORKSPACE_TOOL_NAMES, 'task', 'send_event', 'generate_image'],
  },
  buildSystemPrompt: (ctx) => assemble(workerIdentity, ctx),
  modules: ['image'],
};
