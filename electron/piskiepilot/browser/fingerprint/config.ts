/**
 * 指纹配置 schema、默认值与各平台身份预设。
 * profile 的生效配置 = deep-merge(平台预设, 用户配置)。
 *
 * 移植自 fp-browser/src/config.js(逻辑等价,补 TS 类型)。
 */

import { pickSeed } from './seed.js';

export type FpPlatform = 'macos' | 'windows' | 'linux';

export interface FpGeo {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export type FpProxy = string | { server: string; username?: string; password?: string };

/** 用户传入的指纹配置(全部可选,缺省走平台预设) */
export interface FpUserConfig {
  platform?: FpPlatform;
  seed?: number;
  locale?: string;
  acceptLanguage?: string;
  timezone?: string;
  hardwareConcurrency?: number;
  /** 仅控制内核 DPR；screen 尺寸始终跟随真实显示器。 */
  deviceScaleFactor?: number;
  /** 让 Geolocation API 原生返回位置不可用。 */
  blockGeolocation?: boolean;
  userAgent?: string;
  userAgentMetadata?: Record<string, unknown>;
  gpuVendor?: string;
  gpuRenderer?: string;
  brand?: string;
  brandOverride?: boolean;
  platformVersion?: string;
  geo?: FpGeo;
  proxy?: FpProxy;
  headless?: boolean;
  executablePath?: string;
  /** 固定 chrome user-data-dir(piskie 侧统一指向环境的 chrome-data) */
  userDataDir?: string;
  /** 固定调试端口(联调/外部连接用);缺省 0 = 由内核原子分配,避免预分配端口的抢占竞争 */
  port?: number;
  extraArgs?: string[];
}

/** 平台身份预设 */
export interface PlatformPreset {
  platform: FpPlatform;
  platformVersion: string;
  acceptLanguage: string;
  locale: string;
  /** 仅在环境明确提供时区时覆盖；缺省跟随宿主系统。 */
  timezone?: string;
  hardwareConcurrency: number;
  deviceScaleFactor: number;
  brand: string;
}

/** 合并后的生效配置 */
export interface FpConfig extends PlatformPreset {
  seed: number;
  userAgent?: string;
  userAgentMetadata?: Record<string, unknown>;
  gpuVendor?: string;
  gpuRenderer?: string;
  brandOverride?: boolean;
  blockGeolocation?: boolean;
  geo?: FpGeo;
  proxy?: FpProxy;
  headless?: boolean;
  executablePath?: string;
  userDataDir?: string;
  port?: number;
  extraArgs?: string[];
}

// 各声明 OS 的合理身份预设。deviceMemory 由内核根据合法 seed 派生。
export const PLATFORM_PRESETS: Record<FpPlatform, PlatformPreset> = {
  macos: {
    platform: 'macos',
    platformVersion: '15.0.0',
    acceptLanguage: 'en-US,en',
    locale: 'en-US',
    hardwareConcurrency: 8, // Apple Silicon(M 系 8 核)合理
    deviceScaleFactor: 2,
    brand: 'Google Chrome',
  },
  windows: {
    platform: 'windows',
    platformVersion: '15.0.0', // Win platformVersion(UA-CH),15.0.0 == Win11
    acceptLanguage: 'en-US,en',
    locale: 'en-US',
    hardwareConcurrency: 8,
    deviceScaleFactor: 1,
    brand: 'Google Chrome',
  },
  linux: {
    platform: 'linux',
    platformVersion: '',
    acceptLanguage: 'en-US,en',
    locale: 'en-US',
    hardwareConcurrency: 8,
    deviceScaleFactor: 1,
    brand: 'Google Chrome',
  },
};

/**
 * 由 profileId + 用户覆盖构建生效配置。
 * seed:显式优先,否则由 profileId 确定性派生;两条路径都经 seed.ts 对齐到
 * deviceMemory 只允许浏览器支持的离散值，显式 seed 同样不得绕过校验。
 */
export function resolveConfig(profileId: string, userConfig: FpUserConfig = {}): FpConfig {
  const platform: FpPlatform = userConfig.platform || 'macos';
  const preset = PLATFORM_PRESETS[platform];
  if (!preset) throw new Error(`unknown platform: ${platform}`);
  // 过滤 undefined,避免映射函数显式传的 undefined 抹掉平台预设。
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(userConfig)) {
    if (v !== undefined) clean[k] = v;
  }
  const cfg: FpConfig = {
    ...preset,
    ...(clean as FpUserConfig),
    seed: pickSeed(profileId, userConfig.seed ?? undefined).seed,
  };
  return cfg;
}
