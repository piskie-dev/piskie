import type { WorkerDefinition } from '../worker-definition.js';
import { BROWSER_EXECUTION, WORKER_INSTRUCTIONS } from '../../prompts/identities/worker.js';
import { BROWSER_SCOUT_EXCLUDES } from '../native-tool-sets.js';
import { SITE_SCOUT_INSTRUCTIONS } from '../../prompts/browser-skill/scout.js';

export const siteScoutDefinition: WorkerDefinition = {
  name: 'site-scout',
  description: '有界侦察网站能力、入口、依赖与风险，不设计或编写 Skill',
  instructions: [WORKER_INSTRUCTIONS, BROWSER_EXECUTION, SITE_SCOUT_INSTRUCTIONS].join('\n\n'),
  assignment: 'task-board',
  tools: ['task', 'send_event'].map((name) => ({ name })),
  excludedTools: [...BROWSER_SCOUT_EXCLUDES],
  resources: { browser: { shareWithParent: true } },
  includeSkillDocs: false,
  lifecycle: { onTerminal: 'immediate', deadlineMs: 10 * 60_000 },
  allowedParentSpecs: ['browser-skill-director'],
};
