import { BaseTool } from '../base-tool.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { z } from '../params.js';
import { getBrowserSkillBuildStatus } from '../../browser-skill/application/get-build-status.js';

const schema = z.object({});

export class BrowserSkillStatusTool extends BaseTool<Record<string, never>> {
  readonly def: ToolDef<Record<string, never>> = {
    name: 'browser_skill_status',
    scope: 'main',
    effects: [],
    schema,
    description:
      '读取本次 Browser Skill 工作的构建机器事实：最近 build 成败、源码目录、Skill 名和公开函数。' +
      '只报告构建结果，不判定业务验收是否通过。',
  };

  async execute(_params: Record<string, never>, context: ToolContext): Promise<ToolOutput<unknown>> {
    const state = getBrowserSkillBuildStatus(context.mainAgentId);
    if (!state) return this.success('尚未执行 browser_skill_build。', { state: 'empty' });
    const lastBuild = {
      ok: state.lastBuild.ok,
      sourceDir: state.lastBuild.sourceDir,
      skillName: state.lastBuild.skillName,
      message: state.lastBuild.message,
    };
    const summary = {
      lastBuild,
      currentBuild: state.candidate
        ? {
            skill: state.candidate.skillName,
            sourceDir: state.candidate.sourceDir,
            functions: Object.keys(state.candidate.loaded.functions),
          }
        : null,
    };
    return this.success(JSON.stringify(summary, null, 2), summary);
  }
}
