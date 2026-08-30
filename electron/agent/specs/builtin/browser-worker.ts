import type { AgentSpec } from '../spec.js';
import { WORKSPACE_TOOL_NAMES } from '../native-tool-sets.js';
import { assemble, browserWorkerIdentity } from '../../prompts/index.js';

/** 浏览器工作者：对应 sub browser 模式 */
export const browserWorkerSpec: AgentSpec = {
  name: 'browser-worker',
  role: 'worker',
  tools: {
    sdkGroups: ['browser'],
    customTools: [...WORKSPACE_TOOL_NAMES, 'task', 'send_event', 'generate_image'],
  },
  buildSystemPrompt: (ctx) => assemble(browserWorkerIdentity, ctx),
  modules: ['browser', 'image'],
};
