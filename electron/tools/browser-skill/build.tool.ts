import path from 'node:path';

import { BaseTool } from '../base-tool.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { z } from '../params.js';
import { buildBrowserSkillCandidate } from '../../browser-skill/application/build-candidate.js';
import { browserSkillCandidateOverlay } from '../../browser-skill/candidate-overlay.js';
import type { ToolCatalog } from '../catalog.js';

const schema = z.object({
  sourceDir: z.string().min(1).describe(
    'Browser Skill 源目录。可传绝对路径；相对路径按当前 workspace 解析',
  ),
  skillName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional().describe(
    '可选 Skill 名；省略时从 SKILL.md name 读取',
  ),
});

type Params = z.infer<typeof schema>;

export class BrowserSkillBuildTool extends BaseTool<Params> {
  constructor(private readonly catalog?: ToolCatalog) {
    super();
  }

  readonly def: ToolDef<Params> = {
    name: 'browser_skill_build',
    scope: 'subagent',
    effects: ['read-fs', 'write-fs', 'exec'],
    schema,
    description:
      '编译并热加载待验证的 Browser Skill，不安装、不写 Registry。' +
      '每完成或修改一个具有完整业务意义的公开函数后立即调用；' +
      '不得为了提前构建或定位问题，暴露只供唯一下一步使用的中间函数。成功后用 load_skill 和 skill_call 实测。' +
      '编译失败保留上一份成功构建，并返回精确源码错误。',
  };

  async execute(params: Params, context: ToolContext): Promise<ToolOutput<unknown>> {
    const sourceDir = path.isAbsolute(params.sourceDir)
      ? path.normalize(params.sourceDir)
      : path.resolve(context.workspace.dir, params.sourceDir);
    try {
      browserSkillCandidateOverlay.assertBuildAllowed(context.mainAgentId);
      const candidate = await buildBrowserSkillCandidate({
        mainAgentId: context.mainAgentId,
        sourceDir,
        skillName: params.skillName,
        validateCandidate: (candidate) => {
          if (!this.catalog) return;
          this.catalog.validateSkillReplacement(
            candidate.skillName,
            candidate.loaded.provenance,
            candidate.entries.map((entry) => {
              if (entry.identity?.kind !== 'skill') {
                throw new Error(`Browser Skill build contains a non-Skill entry: ${entry.modelName}`);
              }
              return { tool: entry.tool, identity: entry.identity };
            }),
          );
        },
      });
      return this.success([
        'Browser Skill 已构建并加载。',
        `skill: ${candidate.skillName}`,
        `source: ${candidate.sourceDir}`,
        `functions: ${Object.keys(candidate.loaded.functions).join(', ') || '(none)'}`,
        '下一步：先 load_skill 检查教学和参数，再用 skill_call 真实调用本次完成或修改的公开函数。',
      ].join('\n'), {
        skill: candidate.skillName,
        sourceDir: candidate.sourceDir,
        functions: Object.keys(candidate.loaded.functions),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = browserSkillCandidateOverlay.recordFailure(context.mainAgentId, {
        sourceDir,
        skillName: params.skillName,
        at: new Date().toISOString(),
        message,
      });
      const retained = state.candidate
        ? `\n上一份成功构建仍可用: ${state.candidate.skillName}`
        : '';
      return this.error(`Browser Skill build 失败:\n${message}${retained}`);
    }
  }
}
