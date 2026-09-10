import type { WorkerDefinition } from '../worker-definition.js';
import { BROWSER_EXECUTION, WORKER_INSTRUCTIONS } from '../../prompts/identities/worker.js';
import { BROWSER_READ_NAV_EXCLUDES } from '../native-tool-sets.js';
import { BROWSER_SKILL_VERIFIER_INSTRUCTIONS } from '../../prompts/browser-skill/verifier.js';

export const browserSkillVerifierDefinition: WorkerDefinition = {
  name: 'browser-skill-verifier',
  description: '在独立上下文验证当前 Browser Skill，只验证，不修改或发布',
  instructions: [WORKER_INSTRUCTIONS, BROWSER_EXECUTION, BROWSER_SKILL_VERIFIER_INSTRUCTIONS].join('\n\n'),
  assignment: 'task-board',
  tools: ['task', 'send_event', 'load_skill', 'skill_call'].map((name) => ({ name })),
  excludedTools: [...BROWSER_READ_NAV_EXCLUDES],
  resources: { browser: { shareWithParent: true } },
  includeSkillDocs: false,
  lifecycle: { onTerminal: 'immediate', deadlineMs: 20 * 60_000 },
  allowedParentSpecs: ['browser-skill-director'],
};
