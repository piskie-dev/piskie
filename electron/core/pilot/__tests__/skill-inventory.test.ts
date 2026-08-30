import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getAppPath: () => '/tmp',
  },
}));

import {
  buildSkillInventory,
  createSkillSearchSource,
  emptySkillInventory,
} from '../skill-inventory.js';

interface FakeItem {
  name: string;
  type: string;
  scope: 'user' | 'project';
  path: string;
  description: string;
  enabled: boolean;
  executionType: 'executable' | 'knowledge';
}

function item(input: Partial<FakeItem> & Pick<FakeItem, 'name'>): FakeItem {
  return {
    type: 'local',
    scope: 'user',
    path: `/s/${input.name}`,
    description: `${input.name} 描述`,
    enabled: true,
    executionType: 'knowledge',
    ...input,
  };
}

function createCatalog(
  items: FakeItem[],
  functionsByName: Record<string, string[]> = {},
) {
  return {
    listManagedSkills: vi.fn().mockResolvedValue(items),
    getLoadedSkillModule: vi.fn((name: string) => functionsByName[name]
      ? { functions: Object.fromEntries(functionsByName[name].map((fn) => [fn, {}])) }
      : undefined),
    getSkillDocs: vi.fn().mockResolvedValue('# body'),
    getSkillResourceRoot: vi.fn(() => undefined),
  } as any;
}

describe('buildSkillInventory', () => {
  it('排除内置核心技能与未启用条目，保留外装技能', async () => {
    const catalog = createCatalog([
      item({ name: 'browser', type: 'browser' }),
      item({ name: 'disabled-skill', enabled: false }),
      item({ name: 'example-shop', type: 'browser', description: '示例站点' }),
    ]);
    const result = await buildSkillInventory(catalog);

    expect(result.count).toBe(1);
    expect(result.text).toContain('- example-shop: 示例站点 (file: /s/example-shop/SKILL.md)');
    expect(result.text).not.toContain('- browser:');
    expect(result.text).not.toContain('disabled-skill');
    expect(Object.keys(result.snapshot.entries)).toEqual(['example-shop']);
    expect(result.snapshot.entries['example-shop']).toEqual({ tier: 'full', scope: 'user' });
    expect(result.snapshot.renderedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('清单行带已加载模块的函数键；知识型无 functions 段', async () => {
    const catalog = createCatalog(
      [
        item({ name: 'example-shop', type: 'browser', executionType: 'executable' }),
        item({ name: 'pdf-notes' }),
      ],
      { 'example-shop': ['detectState', 'searchProduct'] },
    );
    const result = await buildSkillInventory(catalog);

    expect(result.text).toContain('[functions: detectState,searchProduct]');
    const pdfLine = result.text.split('\n').find((l) => l.startsWith('- pdf-notes'));
    expect(pdfLine).toBeDefined();
    expect(pdfLine).not.toContain('functions');
  });

  it('executable Skill 的清单和搜索路径指向当前加载版本资源根', async () => {
    const catalog = createCatalog([
      item({ name: 'example-shop', type: 'browser', executionType: 'executable' }),
    ], { 'example-shop': ['searchProduct'] });
    catalog.getSkillResourceRoot.mockReturnValue('/build/example-shop/current/module');

    const inventory = await buildSkillInventory(catalog);
    const searchable = await createSkillSearchSource(catalog).listSearchableSkills();

    expect(inventory.text).toContain(
      '(file: /build/example-shop/current/module/SKILL.md)',
    );
    expect(searchable[0].path).toBe('/build/example-shop/current/module/SKILL.md');
  });

  it('块尾附触发规则；project scope 记入 manifest', async () => {
    const catalog = createCatalog([
      item({ name: 'team-guide', scope: 'project', path: '/ws/.piskie/skills/team-guide' }),
    ]);
    const result = await buildSkillInventory(catalog);

    expect(result.text).toContain('load_skill');
    expect(result.text).toContain('tool_search');
    expect(result.snapshot.entries['team-guide'].scope).toBe('project');
  });

  it('超预算逐级降级，放不下时整条丢弃（omitted）且 manifest 完整记账', async () => {
    const items = Array.from({ length: 80 }, (_, i) => item({
      name: `skill-${String(i).padStart(2, '0')}`,
      description: 'd'.repeat(600),
    }));
    const catalog = createCatalog(items);
    // 预算落到 2000 字符下限，80 条连最小行都放不下 → 触发整条丢弃
    const result = await buildSkillInventory(catalog, { contextWindowTokens: 10_000 });

    const tiers = Object.values(result.snapshot.entries).map((e) => e.tier);
    expect(tiers).toContain('omitted');
    expect(result.count).toBeLessThan(80);
    expect(result.count).toBeGreaterThan(0);
    // 丢尾不丢头
    expect(result.snapshot.entries['skill-00'].tier).not.toBe('omitted');
    expect(result.text).toContain('- skill-00');
    // manifest 覆盖全部 80 条（omitted 也记账——tool_search 互斥基准需要完整视图）
    expect(Object.keys(result.snapshot.entries)).toHaveLength(80);
  });

  it('预算充足时全量 full，描述完整保留', async () => {
    const catalog = createCatalog([
      item({ name: 'a-skill', description: '完整描述内容' }),
      item({ name: 'b-skill', description: '另一条完整描述' }),
    ]);
    const result = await buildSkillInventory(catalog, { contextWindowTokens: 200_000 });

    expect(Object.values(result.snapshot.entries).every((e) => e.tier === 'full')).toBe(true);
    expect(result.text).toContain('完整描述内容');
    expect(result.text).toContain('另一条完整描述');
  });

  it('枚举失败降级为空清单，不阻塞启动', async () => {
    const catalog = {
      listManagedSkills: vi.fn().mockRejectedValue(new Error('runtime not ready')),
      getLoadedSkillModule: vi.fn(),
      getSkillDocs: vi.fn(),
    } as any;
    const result = await buildSkillInventory(catalog);

    expect(result.count).toBe(0);
    expect(result.text).toBe('');
    expect(result.snapshot.entries).toEqual({});
  });

  it('无可见技能时返回空清单（调用方不渲染块）', async () => {
    const catalog = createCatalog([item({ name: 'browser', type: 'browser' })]);
    const result = await buildSkillInventory(catalog);

    expect(result.count).toBe(0);
    expect(result.text).toBe('');
  });
});

describe('emptySkillInventory', () => {
  it('形状与降级路径一致', () => {
    const empty = emptySkillInventory();
    expect(empty).toMatchObject({ text: '', count: 0 });
    expect(empty.snapshot.entries).toEqual({});
  });
});

describe('createSkillSearchSource', () => {
  it('覆盖全部已启用技能（含不进清单的内置核心），带正文', async () => {
    const catalog = createCatalog(
      [
        item({ name: 'browser', type: 'browser' }),
        item({ name: 'example-shop', type: 'browser' }),
        item({ name: 'disabled-skill', enabled: false }),
      ],
      { browser: ['takeSnapshot'] },
    );
    const source = createSkillSearchSource(catalog);
    const skills = await source.listSearchableSkills();

    expect(skills.map((s) => s.name).sort()).toEqual(['browser', 'example-shop']);
    const core = skills.find((s) => s.name === 'browser')!;
    expect(core.functions).toEqual(['takeSnapshot']);
    expect(core.body).toBe('# body');
    expect(core.path).toBe('/s/browser/SKILL.md');
  });

  it('正文读取失败不阻断（body 为 undefined）', async () => {
    const catalog = createCatalog([item({ name: 'example-shop' })]);
    catalog.getSkillDocs.mockRejectedValue(new Error('docs missing'));
    const source = createSkillSearchSource(catalog);
    const skills = await source.listSearchableSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0].body).toBeUndefined();
  });
});
