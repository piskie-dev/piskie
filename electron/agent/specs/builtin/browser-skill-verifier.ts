import type { AgentSpec } from '../spec.js';
import { assemble } from '../../prompts/index.js';
import { browserSkillVerifierIdentity } from '../../prompts/browser-skill/verifier.js';
import { BROWSER_READ_NAV_EXCLUDES } from '../native-tool-sets.js';

export const browserSkillVerifierSpec: AgentSpec = {
  name: 'browser-skill-verifier',
  subagentTypeDescription: '在独立上下文验证当前 Browser Skill，只验证，不修改或发布',
  role: 'worker',
  tools: {
    sdkGroups: ['browser'],
    customTools: ['task', 'send_event', 'load_skill', 'skill_call'],
    exclude: [...BROWSER_READ_NAV_EXCLUDES],
  },
  buildSystemPrompt: (ctx) => assemble(browserSkillVerifierIdentity, ctx),
  lifecycle: { onTerminal: 'immediate', deadlineMs: 20 * 60_000 },
  shareDirectorBrowser: true,
  allowedParentSpecs: ['browser-skill-director'],
  modules: ['browser'],
};
