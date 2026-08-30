import { describe, expect, it } from 'vitest';

import { searchSkills, visibleSkillNames, type SearchableSkill } from '../search.js';

function skill(input: Partial<SearchableSkill> & Pick<SearchableSkill, 'name'>): SearchableSkill {
  return {
    description: '',
    scope: 'user',
    path: `/s/${input.name}/SKILL.md`,
    functions: [],
    ...input,
  };
}

describe('visibleSkillNames', () => {
  it('可见集 = manifest 中 full + trimmed；minimal/omitted 属覆盖集', () => {
    const names = visibleSkillNames({
      renderedAt: '2026-08-08T00:00:00.000Z',
      entries: {
        a: { tier: 'full', scope: 'user' },
        b: { tier: 'trimmed', scope: 'user' },
        c: { tier: 'minimal', scope: 'user' },
        d: { tier: 'omitted', scope: 'user' },
      },
    });
    expect([...names].sort()).toEqual(['a', 'b']);
  });

  it('manifest 缺席时可见集为空（一切可搜）', () => {
    expect(visibleSkillNames(undefined).size).toBe(0);
  });
});

describe('searchSkills', () => {
  const corpus = [
    skill({ name: 'xhs-publisher', description: '小红书图文发布', functions: ['publish'] }),
    skill({ name: 'pdf-notes', description: '整理 PDF 阅读笔记', body: '含 publish 字样的正文' }),
    skill({ name: 'video-clip', description: '视频剪辑', functions: ['clipVideo'] }),
  ];

  it('权重 name > functions > description > body（同词命中取最高档）', () => {
    const hits = searchSkills(corpus, 'publish');
    // name 'xhs-publisher' 含 publish(100) > pdf-notes body(10)
    expect(hits.map((h) => h.name)).toEqual(['xhs-publisher', 'pdf-notes']);
  });

  it('name 精确等于查询词得最高分', () => {
    const hits = searchSkills([
      skill({ name: 'clip', description: '' }),
      skill({ name: 'video-clip', description: '' }),
    ], 'clip');
    expect(hits[0].name).toBe('clip');
  });

  it('多词 AND 优先，全词命中集为空时退化 OR', () => {
    // AND：只有 xhs-publisher 同时含两词
    expect(searchSkills(corpus, '小红书 发布').map((h) => h.name)).toEqual(['xhs-publisher']);
    // 无一条同时命中两词 → OR 并集
    const orHits = searchSkills(corpus, 'pdf 视频').map((h) => h.name);
    expect(orHits.sort()).toEqual(['pdf-notes', 'video-clip']);
  });

  it('exclude 集内的技能不出现在结果', () => {
    const hits = searchSkills(corpus, 'publish', { exclude: new Set(['xhs-publisher']) });
    expect(hits.map((h) => h.name)).toEqual(['pdf-notes']);
  });

  it('结果上限 10 条，description 截到 256 字符单行', () => {
    const many = Array.from({ length: 15 }, (_, i) => skill({
      name: `bulk-${String(i).padStart(2, '0')}`,
      description: `批量技能\n第二行 ${'长'.repeat(300)}`,
    }));
    const hits = searchSkills(many, '批量');
    expect(hits).toHaveLength(10);
    expect(hits[0].description.length).toBeLessThanOrEqual(256);
    expect(hits[0].description).not.toContain('\n');
  });

  it('空查询与全空白查询返回空集', () => {
    expect(searchSkills(corpus, '')).toEqual([]);
    expect(searchSkills(corpus, '  ，、')).toEqual([]);
  });
});
