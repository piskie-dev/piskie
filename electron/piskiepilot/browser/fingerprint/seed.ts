/**
 * Seed 选取。fingerprint-chromium 由 seed 派生 navigator.deviceMemory,
 * 可能吐出违反规范的值(16/32GB,web 规范上限 8),无 flag/CDP 能改。
 *
 * ## 合法性判据
 *
 * 曾用做法是维护一张"deviceMemory 合法的种子白名单"(good-seeds.json,16 个值),
 * 按 profileId 取模落表。该做法把可区分身份数限死在 16 个 —— 3 个环境即有 18% 概率
 * 撞成同一指纹、5 个 50%、12 个 99.7%，这些碰撞均已在真机复现。
 *
 * 对内核 fpc-148 实测 82 个样本(含生产参数、覆盖到 uint32 上界)零例外:
 *
 *     deviceMemory 合法 ⟺ seed ≡ 0 (mod 3)
 *     （≡0 → 8GB 合法;≡1 → 16GB;≡2 → 32GB）
 *
 * 于是白名单可退化为一次取模,合法空间从 16 扩到 ~14.3 亿,碰撞概率降到可忽略。
 *
 * ## 版本绑定
 *
 * 该映射随 fpc 版本可能变化,故与 FPC_RELEASE 锁死(见 binary.ts 软校验)。
 * **升级内核时必须复跑 `scripts/fp-seed-sweep.mjs` 确认判据仍成立**,
 * 再更新下方 LEGAL_SEED_LAW_VERSION。
 */

/** deviceMemory 合法的 seed 步长(实测:3 的倍数 → 8GB) */
const LEGAL_SEED_STEP = 3;

/** 上述判据实测所依据的 fpc 大版本(与 FPC_RELEASE.tag 对齐) */
const LEGAL_SEED_LAW_VERSION = '148';

/** 判据绑定的 fpc 版本(供 binary.ts 版本软校验) */
export function getLegalSeedLawVersion(): string {
  return LEGAL_SEED_LAW_VERSION;
}

/** 任意 uint32 → 最近的合法 seed(向下对齐到步长倍数;0 抬到一个步长) */
export function alignToLegalSeed(raw: number): number {
  const value = raw >>> 0;
  const aligned = value - (value % LEGAL_SEED_STEP);
  return aligned === 0 ? LEGAL_SEED_STEP : aligned;
}

/** 字符串确定性 32bit hash(FNV-1a) → 由 profileId 派生 seed */
export function hashUint32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface PickSeedResult {
  seed: number;
  /** 是否由 profileId 派生(false = 调用方显式指定) */
  derived: boolean;
}

/**
 * profile 的确定性 seed:显式优先,否则由 profileId 派生;两条路径都对齐到合法值。
 * 同一 profileId 跨重启恒定 —— 环境的指纹身份稳定。
 */
export function pickSeed(profileId: string, explicitSeed?: number): PickSeedResult {
  if (explicitSeed != null) {
    return { seed: alignToLegalSeed(explicitSeed), derived: false };
  }
  return { seed: alignToLegalSeed(hashUint32(profileId)), derived: true };
}
