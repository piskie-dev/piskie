import type { AgentSpec } from '../spec.js';
import {
  BROWSER_BUILDER_EXCLUDES,
  WORKSPACE_TOOL_NAMES,
} from '../native-tool-sets.js';
import { assemble } from '../../prompts/index.js';
import { browserSkillBuilderIdentity } from '../../prompts/browser-skill/builder.js';

export const browserSkillBuilderSpec: AgentSpec = {
  name: 'browser-skill-builder',
  subagentTypeDescription: '深入探索目标流程，设计并编写完整业务工具，逐函数即时调用测试和修复',
  role: 'worker',
  tools: {
    sdkGroups: ['browser'],
    customTools: [
      ...WORKSPACE_TOOL_NAMES,
      'task',
      'send_event',
      'load_skill',
      'skill_call',
      'browser_skill_build',
    ],
    exclude: [...BROWSER_BUILDER_EXCLUDES],
  },
  buildSystemPrompt: (ctx) => assemble(browserSkillBuilderIdentity, ctx),
  lifecycle: { onTerminal: 'immediate', deadlineMs: 30 * 60_000 },
  shareDirectorBrowser: true,
  allowedParentSpecs: ['browser-skill-director'],
  modules: ['browser'],
};
