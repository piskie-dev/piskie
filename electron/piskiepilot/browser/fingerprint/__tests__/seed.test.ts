import { describe, expect, it } from 'vitest';
import { alignToLegalSeed, hashUint32, pickSeed } from '../seed.js';
import { resolveConfig } from '../config.js';

/**
 * seed 合法性判据：deviceMemory 合法 ⟺ seed ≡ 0 (mod 3)，实测于 fpc-148。
 * 这些用例锁住的是"任何路径产出的 seed 都必须合法且分散"——
 * 旧的 16 元种子池正是败在分散性上（3 个环境 18% 碰撞，已在真机复现）。
 */

const isLegal = (seed: number) => seed > 0 && seed % 3 === 0;

describe('alignToLegalSeed', () => {
  it('把任意 uint32 对齐到合法值', () => {
    for (const raw of [0, 1, 2, 3, 4, 5, 99, 100, 101, 4294967293, 4294967294, 4294967295]) {
      expect(isLegal(alignToLegalSeed(raw))).toBe(true);
    }
  });

  it('0 与低于一个步长的值抬到最小合法值，不产出 0', () => {
    expect(alignToLegalSeed(0)).toBe(3);
    expect(alignToLegalSeed(1)).toBe(3);
    expect(alignToLegalSeed(2)).toBe(3);
  });

  it('已合法的值保持不变（幂等）', () => {
    for (const seed of [3, 45, 688785363, 4294967292]) {
      expect(alignToLegalSeed(seed)).toBe(seed);
      expect(alignToLegalSeed(alignToLegalSeed(seed))).toBe(seed);
    }
  });
});

describe('pickSeed', () => {
  it('同一 profileId 恒定 —— 环境重启后指纹不变', () => {
    const first = pickSeed('7ff3c86f');
    const again = pickSeed('7ff3c86f');
    expect(again.seed).toBe(first.seed);
    expect(first.derived).toBe(true);
  });

  it('显式 seed 优先，但同样被对齐（不得绕过合法性）', () => {
    expect(pickSeed('any', 45)).toEqual({ seed: 45, derived: false });
    // 46 非法（≡1 mod 3）→ 对齐到 45
    expect(pickSeed('any', 46).seed).toBe(45);
    expect(isLegal(pickSeed('any', 46).seed)).toBe(true);
  });

  it('派生结果一律合法', () => {
    for (let i = 0; i < 500; i++) {
      expect(isLegal(pickSeed(`profile-${i}`).seed)).toBe(true);
    }
  });

  it('大量 profileId 不碰撞 —— 取代 16 元种子池的核心诉求', () => {
    const seeds = new Set<number>();
    const total = 5_000;
    for (let i = 0; i < total; i++) seeds.add(pickSeed(`env-${i}-${i * 7}`).seed);
    // 14.3 亿空间下 5000 个样本的期望碰撞 < 0.01 个；放宽到 2 以免偶发抖动误报
    expect(total - seeds.size).toBeLessThanOrEqual(2);
  });

  it('真实环境 id 的历史碰撞已消除（回归）', () => {
    // 旧池下「内核」与「代理环境」双双落到 seed 15
    const kernel = pickSeed('7ff3c86f').seed;
    const proxied = pickSeed('e5ce9477').seed;
    const direct = pickSeed('75098eda').seed;
    expect(new Set([kernel, proxied, direct]).size).toBe(3);
    for (const seed of [kernel, proxied, direct]) expect(isLegal(seed)).toBe(true);
  });
});

describe('resolveConfig 的 seed 路径', () => {
  it('未指定时由 profileId 派生且合法', () => {
    const cfg = resolveConfig('7ff3c86f');
    expect(cfg.seed).toBe(pickSeed('7ff3c86f').seed);
    expect(isLegal(cfg.seed)).toBe(true);
  });

  it('显式 seed 也经过对齐（此前该路径直通，是合法性缺口）', () => {
    expect(resolveConfig('any', { seed: 46 }).seed).toBe(45);
    expect(isLegal(resolveConfig('any', { seed: 4294967295 }).seed)).toBe(true);
  });
});

describe('hashUint32', () => {
  it('确定性且落在 uint32 域', () => {
    expect(hashUint32('7ff3c86f')).toBe(hashUint32('7ff3c86f'));
    for (const s of ['', 'a', '75098eda', 'x'.repeat(200)]) {
      const h = hashUint32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
