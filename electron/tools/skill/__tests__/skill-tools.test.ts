import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));

import {
  attachSkillProvenance,
  defineSkill,
} from '../../../piskiepilot/core/skill/define.js';
import { renderSkillTeachingDoc } from '../../../skills/discovery/teaching.js';
import { toApiSchema, z } from '../../params.js';
import type { ToolContext } from '../../types.js';
import { LoadSkillTool } from '../load-skill.tool.js';
import { SkillCallTool } from '../skill-call.tool.js';
import { ToolSearchTool } from '../tool-search.tool.js';

const executable = attachSkillProvenance(defineSkill({
  name: 'xhs-publisher',
  domain: 'local',
  functions: {
    detectState: {
      description: '检测页面状态\n第二行详情不进签名',
      params: z.object({ verbose: z.boolean().optional() }),
      async run(params) {
        return { ok: true, text: String(params.verbose ?? false) };
      },
    },
  },
}), {
  root: '/tmp/skills/local',
  trust: 'custom',
  entryPoint: 'skill_call',
});

const fixed = attachSkillProvenance(defineSkill({
  name: 'browser',
  domain: 'browser',
  functions: {
    takeSnapshot: {
      description: '读取页面快照',
      params: z.object({ verbose: z.boolean().optional() }),
      async run() {
        return { ok: true, text: 'snapshot' };
      },
    },
  },
}), {
  root: '/app/skills/browser',
  trust: 'builtin',
  entryPoint: 'direct',
});

function createManager(overrides: Record<string, unknown> = {}) {
  return {
    getSkillDocs: vi.fn().mockResolvedValue('# XHS Publisher Skill\n\n工作流说明。'),
    getLoadedSkillModule: vi.fn((name: string) => {
      if (name === executable.name) return executable;
      if (name === fixed.name) return fixed;
      return undefined;
    }),
    classifySkill: vi.fn().mockResolvedValue('unknown'),
    getSkillResourceRoot: vi.fn(() => undefined),
    listManagedSkills: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

const context = {
  agentSpec: 'director',
  agentId: 'main-agent',
  mainAgentId: 'main-agent',
  runConfig: { name: 'Run', description: '', promptTemplate: '' },
} as ToolContext;

describe('SkillCallTool selector contract', () => {
  it('定义只要求业务选择器，不教学运行时字段', () => {
    const definition = new SkillCallTool().def;
    const schema = JSON.stringify(toApiSchema(definition.schema));

    expect(definition.description).toBe(
      '调用 Skill 使用说明中指定通过本工具执行的公开函数。' +
      'skill、function 和 args 必须与说明中的 Skill 名称、函数名和参数签名一致。',
    );
    expect(schema).toContain('Skill 使用说明中的准确名称');
    expect(schema).toContain('Skill 使用说明列出的公开函数名');
    expect(schema).toContain('函数签名列出的业务参数');
    expect(definition.description).not.toContain('executorId');
    expect(definition.description).not.toContain('taskId');
    expect(definition.description).not.toContain('browserId');
  });

  it('不能绕过 Coordinator 直接执行占位工具', async () => {
    await expect(new SkillCallTool().execute({
      skill: 'xhs-publisher',
      function: 'detectState',
      args: {},
    }, context)).rejects.toThrow(/resolved before PREPARE/);
  });
});

describe('renderSkillTeachingDoc', () => {
  it('渲染 SKILL.md + 当前函数签名（skill_call 调用方式）', async () => {
    const { found, content } = await renderSkillTeachingDoc(createManager(), 'xhs-publisher');

    expect(found).toBe(true);
    expect(content).toContain('# XHS Publisher Skill');
    expect(content).toContain('## 可调用函数');
    expect(content).toContain('`detectState(verbose)`');
    expect(content).toContain('skill_call({ skill: "xhs-publisher"');
    expect(content).toContain('检测页面状态');
    expect(content).not.toContain('第二行详情');
  });

  it('知识型 Skill 明确教学通用工具，而不是 skill_call', async () => {
    const manager = createManager({
      getLoadedSkillModule: vi.fn(() => undefined),
      classifySkill: vi.fn().mockResolvedValue('standard'),
    });
    const { found, content } = await renderSkillTeachingDoc(manager, 'report-writing');

    expect(found).toBe(true);
    expect(content).toContain('# XHS Publisher Skill');
    expect(content).toContain('## 执行方式');
    expect(content).toContain('本技能无注册函数');
    expect(content).toContain('`shell`');
    expect(content).toContain('不要调用 `skill_call`');
  });

  it('递归渲染 enum、默认值、数组、嵌套对象、record 与字段说明', async () => {
    const complex = attachSkillProvenance(defineSkill({
      name: 'complex-browser',
      domain: 'browser',
      functions: {
        search: {
          description: '复杂搜索',
          params: z.object({
            route: z.object({
              cabin: z.enum(['economy', 'business']).default('economy')
                .describe('舱位'),
              passengers: z.array(z.object({
                age: z.number().min(0).max(120).describe('年龄'),
              })).min(1).describe('乘客'),
            }).describe('行程条件'),
            labels: z.record(z.string(), z.string().describe('标签值')).optional(),
          }),
          async run() { return { ok: true, text: 'ok' }; },
        },
      },
    }), {
      root: '/tmp/skills/browser',
      trust: 'custom',
      entryPoint: 'skill_call',
    });
    const manager = createManager({
      getLoadedSkillModule: vi.fn(() => complex),
    });

    const { content } = await renderSkillTeachingDoc(manager, 'complex-browser');

    expect(content).toContain('cabin?: string ("economy" | "business")');
    expect(content).toContain('默认 "economy"');
    expect(content).toContain('舱位');
    expect(content).toContain('array<{ age: number；最小 0；最大 120；年龄 }>');
    expect(content).toContain('至少 1 项');
    expect(content).toContain('record<string, string；标签值>');
  });

  it('固定 Skill 使用下划线 modelName 直接调用', async () => {
    const { found, content, classification } = await renderSkillTeachingDoc(createManager(), 'browser');

    expect(found).toBe(true);
    expect(content).toContain('`browser_takeSnapshot(verbose)`');
    expect(content).toContain('直接调用');
    expect(content).not.toContain('skill_call({');
    expect(classification).toBe('unknown');
  });

  it('prompt-omit 区块在 load_skill 与系统提示词出口都不可见', async () => {
    const manager = createManager({
      getSkillDocs: vi.fn().mockResolvedValue(
        '# Visible\n\n<!-- prompt-omit:start -->\ntaskId / executorId 内部文档\n<!-- prompt-omit:end -->\n\n可见结尾。',
      ),
    });

    for (const opts of [undefined, { forPrompt: true }]) {
      const { content } = await renderSkillTeachingDoc(manager, 'xhs-publisher', opts);
      expect(content).toContain('# Visible');
      expect(content).toContain('可见结尾');
      expect(content).not.toContain('内部文档');
      expect(content).not.toContain('taskId');
      expect(content).not.toContain('executorId');
    }
  });

  it('文档与函数都不存在时报 not found', async () => {
    const manager = createManager({
      getSkillDocs: vi.fn().mockRejectedValue(new Error('missing')),
      getLoadedSkillModule: vi.fn(() => undefined),
    });
    expect((await renderSkillTeachingDoc(manager, 'ghost-skill')).found).toBe(false);
  });

  it('禁用 Skill 在读取文档、模块或文件前即按不可见处理', async () => {
    const getSkillDocs = vi.fn().mockResolvedValue('# 不应暴露');
    const getLoadedSkillModule = vi.fn(() => executable);
    const getSkillResourceRoot = vi.fn(() => '/tmp/disabled-skill');
    const manager = createManager({
      classifySkill: vi.fn().mockResolvedValue('disabled'),
      getSkillDocs,
      getLoadedSkillModule,
      getSkillResourceRoot,
    });

    const rendered = await renderSkillTeachingDoc(manager, 'xhs-publisher');

    expect(rendered).toEqual({
      found: false,
      content: '',
      classification: 'disabled',
    });
    expect(getSkillDocs).not.toHaveBeenCalled();
    expect(getLoadedSkillModule).not.toHaveBeenCalled();
    expect(getSkillResourceRoot).not.toHaveBeenCalled();
  });
});

describe('LoadSkillTool', () => {
  it('说明交代使用时机并遵循返回教学', () => {
    const definition = new LoadSkillTool(createManager()).def;
    const schema = toApiSchema(definition.schema);

    expect(definition.description).toBe(
      '加载指定 Skill 的使用说明。准备亲自使用 Skill 时调用，' +
      '并按返回内容使用相应工具、参数和资源。',
    );
    expect((schema.properties as Record<string, { description?: string }>).skill.description)
      .toBe('要加载的准确 Skill 名称');
  });

  it('返回教学包全文', async () => {
    const result = await new LoadSkillTool(createManager()).execute(
      { skill: 'xhs-publisher' },
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain('可调用函数');
  });

  it('猜中禁用 Skill 时与不可用名称使用相同的通用错误', async () => {
    const manager = createManager({
      classifySkill: vi.fn().mockResolvedValue('disabled'),
    });
    const result = await new LoadSkillTool(manager).execute({ skill: 'xhs-publisher' }, context);

    expect(result.ok).toBe(false);
    expect(result.text).toContain('不存在');
    expect(result.text).toContain('tool_search');
    expect(result.text).not.toContain('禁用');
    expect(result.text).not.toContain('piskie skill enable');
    expect(result.text).not.toContain('工作流说明');
  });

  it('未知技能名附最接近候选（编辑距离 top 3）并指引 tool_search', async () => {
    const manager = createManager({
      getSkillDocs: vi.fn().mockRejectedValue(new Error('missing')),
      getLoadedSkillModule: vi.fn(() => undefined),
      listManagedSkills: vi.fn().mockResolvedValue([
        { name: 'xhs-publisher', enabled: true },
        { name: 'xhs-search', enabled: true },
        { name: 'pdf-notes', enabled: true },
        { name: 'video-clip', enabled: true },
      ]),
    });
    const result = await new LoadSkillTool(manager).execute({ skill: 'xhs-publiser' }, context);

    expect(result.ok).toBe(false);
    expect(result.text).toContain('tool_search');
    expect(result.text).toContain('xhs-publisher');
    // top3：不含编辑距离最远的候选
    expect(result.text).not.toContain('video-clip');
  });
});

describe('ToolSearchTool', () => {
  const skills = [
    {
      name: 'xhs-publisher',
      description: '小红书图文发布：登录态检测、图文上传',
      type: 'browser',
      scope: 'user' as const,
      path: '/skills/browser/xhs-publisher/SKILL.md',
      functions: ['detectState', 'publish'],
    },
    {
      name: 'pdf-notes',
      description: 'PDF 阅读笔记与摘要整理',
      type: 'local',
      scope: 'user' as const,
      path: '/skills/local/pdf-notes/SKILL.md',
      functions: [],
    },
  ];
  const source = { listSearchableSkills: vi.fn().mockResolvedValue(skills) };

  it('关键词命中返回带 scope 的结果', async () => {
    const result = await new ToolSearchTool(source).execute({ query: '小红书 发布' }, context);

    expect(result.ok).toBe(true);
    const data = result.data as { count: number; results: Array<{ name: string; kind: string }> };
    expect(data.count).toBe(1);
    expect(data.results[0].name).toBe('xhs-publisher');
    expect(data.results[0].kind).toBe('skill');
    expect(result.text).toContain('(user)');
    expect(result.text).toContain('load_skill');
  });

  it('互斥不变量：manifest 中 full/trimmed 的技能不出现在结果里', async () => {
    const ctx = {
      ...context,
      skillInventory: {
        renderedAt: '2026-08-08T00:00:00.000Z',
        entries: {
          'xhs-publisher': { tier: 'full', scope: 'user' },
          'pdf-notes': { tier: 'minimal', scope: 'user' },
        },
      },
    } as unknown as ToolContext;
    const result = await new ToolSearchTool(source).execute({ query: 'pdf 小红书' }, ctx);

    expect(result.ok).toBe(true);
    const data = result.data as { results: Array<{ name: string }> };
    // full 被互斥排除；minimal 属覆盖集可搜到
    expect(data.results.map((r) => r.name)).toEqual(['pdf-notes']);
  });

  it('互斥不变量：快照后新装的技能不在 manifest，可被搜到', async () => {
    const ctx = {
      ...context,
      skillInventory: {
        renderedAt: '2026-08-08T00:00:00.000Z',
        entries: {
          'xhs-publisher': { tier: 'full', scope: 'user' },
        },
      },
    } as unknown as ToolContext;
    const result = await new ToolSearchTool(source).execute({ query: 'pdf 笔记' }, ctx);

    expect(result.ok).toBe(true);
    const data = result.data as { results: Array<{ name: string }> };
    expect(data.results.map((r) => r.name)).toEqual(['pdf-notes']);
  });

  it('零命中给出远程检索指引', async () => {
    const result = await new ToolSearchTool(source).execute({ query: 'nonexistent-capability' }, context);

    expect(result.ok).toBe(true);
    const data = result.data as { count: number; hint?: string };
    expect(data.count).toBe(0);
    expect(data.hint).toContain('piskie skill search');
  });

  it('select: 形式在无 deferred 工具时明确说明', async () => {
    const result = await new ToolSearchTool(source).execute({ query: 'select:mcp__github__create_issue' }, context);

    expect(result.ok).toBe(true);
    expect(result.text).toContain('No deferred tools');
  });

  it('deferred MCP 关键词命中返回标准结果并装载，装载后不再被搜索到', async () => {
    const pending = new Map([
      ['mcp__github__create_issue', {
        modelName: 'mcp__github__create_issue',
        server: 'github',
        description: 'Create a repository issue',
      }],
    ]);
    const load = vi.fn((names: readonly string[]) => {
      const loaded = names.filter((name) => pending.delete(name));
      return { loaded, unknown: names.filter((name) => !loaded.includes(name)) };
    });
    const ctx = {
      ...context,
      deferredTools: { list: () => [...pending.values()], load },
    } as unknown as ToolContext;
    const tool = new ToolSearchTool({ listSearchableSkills: vi.fn().mockResolvedValue([]) });

    const first = await tool.execute({ query: 'github issue' }, ctx);
    expect(first.ok).toBe(true);
    expect(first.data).toMatchObject({
      count: 1,
      results: [{
        kind: 'mcp-tool',
        name: 'mcp__github__create_issue',
        server: 'github',
        loaded: true,
      }],
      loadedTools: ['mcp__github__create_issue'],
    });
    expect(load).toHaveBeenCalledTimes(1);

    const second = await tool.execute({ query: 'github issue' }, ctx);
    expect(second.data).toMatchObject({ count: 0, results: [] });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('select: 精确装载返回 mcp-tool 结果，单次拒绝超过五项', async () => {
    const listings = Array.from({ length: 6 }, (_, index) => ({
      modelName: `mcp__srv__tool_${index}`,
      server: 'srv',
      description: `Tool ${index}`,
    }));
    const load = vi.fn((names: readonly string[]) => ({ loaded: [...names], unknown: [] }));
    const ctx = {
      ...context,
      deferredTools: { list: () => listings, load },
    } as ToolContext;
    const tool = new ToolSearchTool(source);

    const selected = await tool.execute({ query: 'select:mcp__srv__tool_0' }, ctx);
    expect(selected.data).toMatchObject({
      results: [{ kind: 'mcp-tool', name: 'mcp__srv__tool_0', loaded: true }],
    });

    const overflow = await tool.execute({
      query: `select:${listings.map((item) => item.modelName).join(',')}`,
    }, ctx);
    expect(overflow.ok).toBe(false);
    expect(overflow.text).toContain('at most 5');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('关键词最多装载五个 MCP 工具，统一结果总数不超过十条', async () => {
    const manySkills = Array.from({ length: 12 }, (_, index) => ({
      name: `issue-skill-${index}`,
      description: 'issue workflow',
      type: 'local',
      scope: 'user' as const,
      path: `/skills/issue-${index}/SKILL.md`,
      functions: [],
    }));
    const deferred = Array.from({ length: 8 }, (_, index) => ({
      modelName: `mcp__srv__issue_${index}`,
      server: 'srv',
      description: `Issue tool ${index}`,
    }));
    const load = vi.fn((names: readonly string[]) => ({ loaded: [...names], unknown: [] }));
    const ctx = {
      ...context,
      deferredTools: { list: () => deferred, load },
    } as ToolContext;
    const tool = new ToolSearchTool({ listSearchableSkills: vi.fn().mockResolvedValue(manySkills) });

    const result = await tool.execute({ query: 'issue' }, ctx);
    const data = result.data as { count: number; results: Array<{ kind: string }>; loadedTools: string[] };
    expect(data.loadedTools).toHaveLength(5);
    expect(data.results.filter((item) => item.kind === 'mcp-tool')).toHaveLength(5);
    expect(data.count).toBe(10);
    expect(data.results).toHaveLength(10);
  });
});
