import { BaseTool } from '../base-tool.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { bool, z } from '../params.js';
import { publishBrowserSkillCandidate } from '../../browser-skill/application/publish-skill.js';
import type { SkillsPort } from '../../skills/ports.js';

const schema = z.object({
  force: bool().default(false).describe('同名已安装 Skill 存在时是否替换'),
});

type Params = z.infer<typeof schema>;

export class BrowserSkillPublishTool extends BaseTool<Params> {
  constructor(private readonly skills?: Pick<SkillsPort, 'install'>) {
    super();
  }

  readonly def: ToolDef<Params> = {
    name: 'browser_skill_publish',
    scope: 'main',
    effects: ['read-fs', 'write-fs', 'exec'],
    schema,
    description:
      '发布已根据独立验收报告确认通过的当前 Browser Skill。' +
      '本工具不存储或判定验证结论；它在内部校验当前构建与源码一致后，' +
      '复用统一 Piskie executable Skill 安装链更新 Registry、管理视图和运行时。',
  };

  async execute(params: Params, context: ToolContext): Promise<ToolOutput<unknown>> {
    try {
      const outcome = await publishBrowserSkillCandidate({
        mainAgentId: context.mainAgentId,
        force: params.force,
      }, this.skills);
      return this.success([
        `Browser Skill 已通过统一安装链发布: ${outcome.name}`,
        `path: ${outcome.path}`,
        `type: ${outcome.type ?? 'browser'}`,
      ].join('\n'), outcome);
    } catch (error) {
      return this.error(`Browser Skill 发布失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
