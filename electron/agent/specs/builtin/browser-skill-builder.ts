import type { WorkerDefinition } from '../worker-definition.js';
import { BROWSER_EXECUTION, WORKER_INSTRUCTIONS } from '../../prompts/identities/worker.js';
import { BROWSER_BUILDER_EXCLUDES, WORKSPACE_TOOL_NAMES } from '../native-tool-sets.js';
import { BROWSER_SKILL_BUILDER_INSTRUCTIONS } from '../../prompts/browser-skill/builder.js';
import { renderBrowserSkillAuthoringGuide } from '../../prompts/browser-skill/authoring-guide.js';
import { renderBrowserSkillSdkReference } from '../../prompts/browser-skill/sdk-reference.js';

export const browserSkillBuilderDefinition: WorkerDefinition = {
  name: 'browser-skill-builder',
  description: '深入探索目标流程，设计并编写完整业务工具，逐函数即时调用测试和修复',
  instructions: [WORKER_INSTRUCTIONS, BROWSER_EXECUTION, BROWSER_SKILL_BUILDER_INSTRUCTIONS, renderBrowserSkillAuthoringGuide(), renderBrowserSkillSdkReference()].join('\n\n'),
  assignment: 'task-board',
  tools: [...WORKSPACE_TOOL_NAMES, 'task', 'send_event', 'load_skill', 'skill_call', 'browser_skill_build'].map((name) => ({ name })),
  excludedTools: [...BROWSER_BUILDER_EXCLUDES],
  resources: { browser: { shareWithParent: true } },
  includeSkillDocs: true,
  lifecycle: { onTerminal: 'immediate', deadlineMs: 30 * 60_000 },
  allowedParentSpecs: ['browser-skill-director'],
};
