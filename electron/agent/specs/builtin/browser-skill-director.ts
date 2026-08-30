import type { AgentSpec } from '../spec.js';
import { assemble } from '../../prompts/index.js';
import { browserSkillDirectorIdentity } from '../../prompts/browser-skill/director.js';
import { directorSpec } from './director.js';

/** Browser Skill 构建协调者：通用 Director 工具面只增加 status/publish。 */
export const browserSkillDirectorSpec: AgentSpec = {
  name: 'browser-skill-director',
  role: 'director',
  tools: {
    sdkGroups: [...directorSpec.tools.sdkGroups],
    customTools: [
      ...directorSpec.tools.customTools,
      'browser_skill_status',
      'browser_skill_publish',
    ],
    exclude: directorSpec.tools.exclude ? [...directorSpec.tools.exclude] : undefined,
  },
  buildSystemPrompt: (ctx) => assemble(browserSkillDirectorIdentity, ctx),
  modules: [...directorSpec.modules],
};
