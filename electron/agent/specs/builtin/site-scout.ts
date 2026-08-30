import type { AgentSpec } from '../spec.js';
import { assemble } from '../../prompts/index.js';
import { siteScoutIdentity } from '../../prompts/browser-skill/scout.js';
import { BROWSER_SCOUT_EXCLUDES } from '../native-tool-sets.js';

export const siteScoutSpec: AgentSpec = {
  name: 'site-scout',
  subagentTypeDescription: '有界侦察网站能力、入口、依赖与风险，不设计或编写 Skill',
  role: 'worker',
  tools: {
    sdkGroups: ['browser'],
    customTools: ['task', 'send_event'],
    exclude: [...BROWSER_SCOUT_EXCLUDES, 'load_skill', 'skill_call'],
  },
  buildSystemPrompt: (ctx) => assemble(siteScoutIdentity, ctx),
  lifecycle: { onTerminal: 'immediate', deadlineMs: 10 * 60_000 },
  shareDirectorBrowser: true,
  allowedParentSpecs: ['browser-skill-director'],
  modules: ['browser'],
};
