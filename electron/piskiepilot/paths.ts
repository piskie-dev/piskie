/**
 * piskiepilot 状态路径唯一入口
 *
 * 全部状态收敛于单根 {userData}/piskiepilot:
 *   browsers/ user-data/ skills/
 *
 * 本文件不 import electron(vitest 等无 electron 环境可直接使用):
 * PISKIE 初始化时由 PilotRuntimeHost 调用 setPilotRoot 注入
 * path.join(app.getPath('userData'), 'piskiepilot');
 * 未注入(无 electron 环境)回退 cwd/.piskiepilot。
 *
 * 注意:生产环境 bootstrap.ts 已 setPath('userData', ~/.piskie),
 * 因此生产上状态根为 ~/.piskie/piskiepilot。
 */

import { join } from 'path';

let injectedRoot: string | null = null;

/** 注入状态根(PISKIE 初始化处调用,须早于任何状态读写) */
export function setPilotRoot(root: string): void {
  injectedRoot = root;
}

/** 状态唯一根:{userData}/piskiepilot;无 electron 环境回退 cwd/.piskiepilot */
export function getPilotRoot(): string {
  return injectedRoot ?? join(process.cwd(), '.piskiepilot');
}

// ==================== 浏览器运行时状态 ====================

/** 浏览器实例持久化目录 */
export function getBrowsersDir(): string {
  return join(getPilotRoot(), 'browsers');
}

/** userData profile 根目录(登录态所在) */
export function getUserDataRoot(): string {
  return join(getPilotRoot(), 'user-data');
}

/**
 * 指纹浏览器(fingerprint-chromium)二进制缓存根目录
 *
 * 下层按 <host-key> 分目录；也可用 FP_CHROMIUM_PATH 指向开发/联调用内核。
 */
export function getFingerprintBinDir(): string {
  return join(getPilotRoot(), 'fingerprint-bin');
}

// ==================== skills ====================

/** skills 根目录 */
export function getSkillsRootDir(): string {
  return join(getPilotRoot(), 'skills');
}

/** 指定类型 skills 目录(browser/local) */
export function getSkillsDirByType(type: string): string {
  return join(getSkillsRootDir(), type);
}
