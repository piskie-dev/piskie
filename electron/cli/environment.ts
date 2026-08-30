import os from 'node:os';
import path from 'node:path';

import { setPilotRoot } from '@electron/piskiepilot/paths.js';

export interface ConfigRootEnvironment {
  PISKIE_CONFIG_ROOT?: string;
}

/** 配置根解析：PISKIE_CONFIG_ROOT → 缺省 ~/.piskie */
export function resolvePiskieConfigRoot(
  environment: ConfigRootEnvironment = process.env,
  homeDirectory: string = os.homedir(),
): string {
  if (environment.PISKIE_CONFIG_ROOT) return path.resolve(environment.PISKIE_CONFIG_ROOT);
  return path.resolve(homeDirectory, '.piskie');
}

/** pilot 状态根：{configRoot}/piskiepilot（技能根在其下 skills） */
export function resolvePilotRoot(configRoot: string): string {
  return path.join(configRoot, 'piskiepilot');
}

export interface CliEnvironment {
  configRoot: string;
  pilotRoot: string;
}

/**
 * CLI 进程环境初始化：解析配置根并注入 pilot 状态根。
 * 必须先于任何技能状态读写调用（路径消费方 lazy 取值，注入后才指向正确根）。
 */
export function initializeCliEnvironment(
  explicitRoot?: string,
  environment?: ConfigRootEnvironment,
  homeDirectory?: string,
): CliEnvironment {
  const configRoot = explicitRoot
    ? path.resolve(explicitRoot)
    : resolvePiskieConfigRoot(environment, homeDirectory);
  const pilotRoot = resolvePilotRoot(configRoot);
  setPilotRoot(pilotRoot);
  return { configRoot, pilotRoot };
}
