import { describe, expect, it } from 'vitest';

import { inventoryBudgetChars, renderSkillInventory, type InventorySkill } from '../inventory.js';

function skill(input: Partial<InventorySkill> & Pick<InventorySkill, 'name'>): InventorySkill {
  return {
    description: `${input.name} 描述`,
    scope: 'user',
    path: `/root/skills/local/${input.name}/SKILL.md`,
    functions: [],
    ...input,
  };
}

describe('inventoryBudgetChars', () => {
  it('窗口 2% × 4 字符/token，下限 2000，缺省 8000', () => {
    expect(inventoryBudgetChars(200_000)).toBe(16_000);
    expect(inventoryBudgetChars(10_000)).toBe(2000);
    expect(inventoryBudgetChars()).toBe(8000);
    expect(inventoryBudgetChars(0)).toBe(8000);
  });
});

describe('renderSkillInventory', () => {
  it('预算充足：全量行含 description/path/functions，tier=full', () => {
    const { text, snapshot, omitted } = renderSkillInventory([
      skill({ name: 'shop', description: '示例站点', functions: ['detect', 'buy'] }),
    ]);

    expect(text).toContain('- shop: 示例站点 (file: /root/skills/local/shop/SKILL.md) [functions: detect,buy]');
    expect(snapshot.entries['shop'].tier).toBe('full');
    expect(omitted).toEqual([]);
  });

  it('waterfill：超预算时长描述先被裁到 cap，短描述保持原样', () => {
    const shortDesc = '短描述保持原样';
    const skills = [
      skill({ name: 'long-a', description: 'a'.repeat(900) }),
      skill({ name: 'long-b', description: 'b'.repeat(900) }),
      skill({ name: 'short-c', description: shortDesc }),
    ];
    // 固定成本(名+路径+16)×3 ≈ 160；预算 400 → 描述池 ≈ 240，两条 900 必被裁
    const { text, snapshot } = renderSkillInventory(skills, { contextWindowTokens: 5000 });
    const budget = inventoryBudgetChars(5000);

    expect(snapshot.entries['long-a'].tier).toBe('trimmed');
    expect(snapshot.entries['long-b'].tier).toBe('trimmed');
    expect(snapshot.entries['short-c'].tier).toBe('full');
    expect(text).toContain(shortDesc);
    expect(text).toContain('…');
    expect(text.length).toBeLessThanOrEqual(budget);
    // 裁剪对称：两条同长描述得到同一 cap
    const lenOf = (name: string) =>
      text.split('\n').find((l) => l.startsWith(`- ${name}:`))!.length;
    expect(lenOf('long-a')).toBe(lenOf('long-b'));
  });

  it('description 折叠为单行并硬截断到 1024 字符', () => {
    const { text } = renderSkillInventory([
      skill({ name: 'multi', description: `多行\n描述\t 内容 ${'很'.repeat(1200)}` }),
    ], { contextWindowTokens: 1_000_000 });
    const line = text.split('\n').find((l) => l.startsWith('- multi:'))!;

    expect(line).toContain('多行 描述 内容');
    expect(line).not.toContain('\t');
    expect(line.length).toBeLessThan(1200);
  });

  it('描述裁光仍超预算时共享根路径提为别名表，避免整条丢弃', () => {
    // 30 条 × 长路径：固定成本(名+路径+16)≈2160 已超 2000 预算 → 别名压缩后回到预算内
    const prefix = '/very/long/shared/skills/root/local';
    const skills = Array.from({ length: 30 }, (_, i) => skill({
      name: `sk-${String(i).padStart(2, '0')}`,
      description: 'd'.repeat(100),
      path: `${prefix}/sk-${String(i).padStart(2, '0')}/SKILL.md`,
    }));
    const { text, snapshot, omitted } = renderSkillInventory(skills, { contextWindowTokens: 10_000 });

    expect(text).toContain(`r0 = ${prefix}`);
    expect(text).toContain('(file: r0/sk-00/SKILL.md)');
    expect(omitted).toEqual([]);
    expect(snapshot.entries['sk-00'].tier).not.toBe('omitted');
  });

  it('minimal 行只留名字与路径；omit 从尾部丢，manifest 记 omitted', () => {
    const skills = Array.from({ length: 60 }, (_, i) => skill({
      name: `skill-${String(i).padStart(2, '0')}`,
      description: 'd'.repeat(300),
      path: `/s/skill-${String(i).padStart(2, '0')}/SKILL.md`,
      functions: ['fn'],
    }));
    const { text, snapshot, omitted } = renderSkillInventory(skills, { contextWindowTokens: 10_000 });

    expect(omitted.length).toBeGreaterThan(0);
    expect(snapshot.entries[omitted[0]].tier).toBe('omitted');
    expect(text).not.toContain(`- ${omitted[0]}:`);
    // 头部保留且降为 minimal（无描述、无 functions 段）
    const headLine = text.split('\n').find((l) => l.startsWith('- skill-00'))!;
    expect(headLine).toBe('- skill-00: (file: /s/skill-00/SKILL.md)');
    expect(snapshot.entries['skill-00'].tier).toBe('minimal');
    // manifest 覆盖全部 60 条
    expect(Object.keys(snapshot.entries)).toHaveLength(60);
  });

  it('块尾始终附触发规则', () => {
    const { text } = renderSkillInventory([skill({ name: 'one' })]);
    expect(text).toContain('亲自使用时先 load_skill');
    expect(text).toContain('委派时将技能名填入 Worker 的 skills');
    expect(text).toContain('未匹配到技能时，根据任务所需能力选择合适的 Worker');
    expect(text).toContain('tool_search');
  });
});
