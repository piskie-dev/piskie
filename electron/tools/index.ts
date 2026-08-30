import type { SkillCatalogPort } from '../core/pilot/index.js';
import type { PilotRuntime } from '../piskiepilot/runtime/pilot-runtime.js';
import { ToolCatalog } from './catalog.js';
import { buildLoadedSkillEntries } from './skill/domain-descriptors.js';
import type { ITool } from './types.js';
import { SubagentTool } from './agent/subagent.tool.js';
import { SendEventTool } from './agent/send-event.tool.js';
import { AgentRunTool } from './agent/agent-run.tool.js';
import { PlanTool } from './plan/plan.tool.js';
import { AskUserTool } from './plan/ask-user.tool.js';
import { TaskTool } from './task/task.tool.js';
import { TaskReadTool } from './task/task-read.tool.js';
import { GenerateImageTool } from './image/generate-image.tool.js';
import { SkillCallTool } from './skill/skill-call.tool.js';
import { LoadSkillTool } from './skill/load-skill.tool.js';
import { ToolSearchTool } from './skill/tool-search.tool.js';
import { createSkillSearchSource } from '../core/pilot/skill-inventory.js';
import { ReadTool } from './fs/read.tool.js';
import { WriteTool } from './fs/write.tool.js';
import { EditTool } from './fs/edit.tool.js';
import { GlobTool } from './fs/glob.tool.js';
import { GrepTool } from './fs/grep.tool.js';
import { LsTool } from './fs/ls.tool.js';
import { ShellTool } from './shell/shell.tool.js';
import { BrowserSkillBuildTool } from './browser-skill/build.tool.js';
import { BrowserSkillStatusTool } from './browser-skill/status.tool.js';
import { BrowserSkillPublishTool } from './browser-skill/publish.tool.js';

const builtinTools = (
  skills?: SkillCatalogPort,
  catalog?: ToolCatalog,
): ITool<any, any>[] => [
  new SubagentTool(),
  new SendEventTool(),
  new AgentRunTool(),
  new PlanTool(),
  new TaskTool(),
  new TaskReadTool(),
  new AskUserTool(),
  new SkillCallTool(),
  new LoadSkillTool(skills),
  new GenerateImageTool(),
  new ReadTool(),
  new WriteTool(),
  new EditTool(),
  new GlobTool(),
  new GrepTool(),
  new LsTool(),
  new ShellTool(),
  new ToolSearchTool(skills ? createSkillSearchSource(skills) : undefined),
  new BrowserSkillBuildTool(catalog),
  new BrowserSkillStatusTool(),
  new BrowserSkillPublishTool(),
];

/** Build the process-owned catalog once, after all three Skill loaders are ready. */
export function createProcessToolCatalog(
  skills: SkillCatalogPort | undefined,
  runtime: PilotRuntime | undefined,
): ToolCatalog {
  const catalog = new ToolCatalog();
  for (const tool of builtinTools(skills, catalog)) catalog.register(tool, 'builtin');

  for (const skill of runtime?.getExecutableSkills() ?? []) {
    const entries = buildLoadedSkillEntries(skill);
    catalog.validateSkillReplacement(skill.name, skill.provenance, entries);
    catalog.replaceSkill(skill.name, skill.provenance, entries);
  }
  return catalog;
}

let standaloneCatalog: ToolCatalog | undefined;

/** Process-wide native-only catalog used by isolated runtimes and unit tests. */
export function getStandaloneToolCatalog(): ToolCatalog {
  standaloneCatalog ??= createProcessToolCatalog(undefined, undefined);
  return standaloneCatalog;
}
