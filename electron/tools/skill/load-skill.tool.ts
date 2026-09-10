/** LoadSkillTool - 加载可用 Skill 的教学内容。 */

import { BaseTool } from '../base-tool.js';
import type {
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';
import { z } from '../params.js';
import type { SkillCatalogPort } from '../../core/pilot/index.js';
import {
  renderCandidateSkillTeaching,
  renderAvailableSkillTeaching,
} from '../../skills/discovery/teaching.js';
import { listAvailableSkills } from '../../skills/discovery/resolve.js';
import { pathsService } from '../../services/paths.service.js';
import {
  browserSkillCandidateOverlay,
  canAccessBrowserSkillCandidate,
} from '../../browser-skill/candidate-overlay.js';

const loadSkillSchema = z.object({
  skill: z.string().min(1).describe('要加载的准确 Skill 名称'),
});
type LoadSkillParams = z.infer<typeof loadSkillSchema>;

export class LoadSkillTool extends BaseTool<LoadSkillParams> {
  constructor(private readonly skills?: SkillCatalogPort) {
    super();
  }

  readonly def: ToolDef<LoadSkillParams> = {
    name: 'load_skill',
    scope: 'shared',
    effects: [],
    schema: loadSkillSchema,
    description: '加载指定 Skill 的使用说明。准备亲自使用 Skill 时调用，' +
      '并按返回内容使用相应工具、参数和资源。',
  };

  async execute(
    params: LoadSkillParams,
    context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    const skill = params.skill.trim();
    if (!skill) {
      return this.error('skill 为必填');
    }

    const agentSpecName = context.agentSpec;
    const candidate = canAccessBrowserSkillCandidate(agentSpecName)
      ? browserSkillCandidateOverlay.candidate(context.mainAgentId, skill, context.agentId)
      : undefined;
    if (candidate) {
      return this.success(await renderCandidateSkillTeaching({
        skillName: candidate.skillName,
        resourceRoot: candidate.resourceRoot,
        module: candidate.loaded,
      }), { skill });
    }

    const skills = this.skills;
    if (!skills) {
      return this.error('Skill catalog is not available');
    }

    const workspace = context.runConfig.workspace;
    const rendered = await renderAvailableSkillTeaching(skills, skill, {
      workspace,
      defaultWorkspaceDir: workspace ? pathsService.getDefaultWorkspaceDir() : undefined,
    });
    if (rendered?.found) {
      return this.success(rendered.content, { skill, scope: rendered.scope });
    }

    return this.error(await this.unknownSkillMessage(skills, skill, workspace));
  }

  /** 错误自愈：附本 agent 可发现技能的最接近候选（编辑距离 top 3） */
  private async unknownSkillMessage(
    skills: SkillCatalogPort,
    skill: string,
    workspace: string | undefined,
  ): Promise<string> {
    let candidates: string[] = [];
    try {
      const items = await listAvailableSkills(skills, {
        workspace,
        defaultWorkspaceDir: workspace ? pathsService.getDefaultWorkspaceDir() : undefined,
      });
      candidates = closestNames(items.filter((i) => i.enabled).map((i) => i.name), skill, 3);
    } catch {
      candidates = [];
    }
    const suggestion = candidates.length > 0 ? `最接近的已安装技能：${candidates.join('、')}。` : '';
    return `技能 "${skill}" 不存在。${suggestion}清单外技能请先 tool_search 检索。`;
  }
}

function closestNames(names: string[], target: string, limit: number): string[] {
  return names
    .map((name) => ({ name, distance: levenshtein(name.toLowerCase(), target.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const insertOrDelete = Math.min(prev[j], prev[j - 1]) + 1;
      const substitute = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      diagonal = prev[j];
      prev[j] = Math.min(insertOrDelete, substitute);
    }
  }
  return prev[b.length];
}
