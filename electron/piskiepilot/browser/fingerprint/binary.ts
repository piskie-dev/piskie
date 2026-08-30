/**
 * 解析当前 host 的 fingerprint-chromium 可执行文件路径。
 * 启动阶段只解析已安装文件，不隐式下载，也不 fallback 到系统 Chrome。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getFingerprintBinDir } from '@electron/piskiepilot/paths.js';
import { HOST_KEY, cacheExecPath } from './host.js';
import {
  FPC_RELEASE,
  getDownloadProgress,
  hasAssetForHost,
  isInstalled,
  type DownloadProgress,
} from './downloader.js';

export { HOST_KEY };

export interface KernelStatus {
  hostKey: string;
  installed: boolean;
  hasAsset: boolean;
  version: string;
  progress?: DownloadProgress;
}

export async function resolveExecutable(override?: string): Promise<string> {
  // 1. 环境变量(开发/联调最高优先)
  const envPath = process.env.FP_CHROMIUM_PATH;
  if (envPath) {
    if (!existsSync(envPath)) throw new Error(`FP_CHROMIUM_PATH 指向的文件不存在: ${envPath}`);
    return envPath;
  }

  // 2. 显式 override
  if (override) {
    if (!existsSync(override)) throw new Error(`executable not found: ${override}`);
    return override;
  }

  // 3. 固定缓存目录命中
  const cached = cacheExecPath();
  if (!cached) throw new Error(`no fingerprint-chromium host-key mapping for host ${HOST_KEY}`);
  if (existsSync(cached)) return cached;

  if (hasAssetForHost()) {
    throw new Error(
      '浏览器内核尚未就绪，可能仍在后台下载；请等待安装完成后重新启动浏览器任务，若持续失败请到系统设置查看安装状态',
    );
  }
  throw new Error(
    `当前平台没有可安装的浏览器内核(host=${HOST_KEY})。` +
      `请设置 FP_CHROMIUM_PATH 或手动放置到 ${join(getFingerprintBinDir(), HOST_KEY)}/`,
  );
}

export function getKernelStatus(hostKey: string = HOST_KEY): KernelStatus {
  return {
    hostKey,
    installed: isInstalled(hostKey),
    hasAsset: hasAssetForHost(hostKey),
    version: FPC_RELEASE.tag,
    progress: getDownloadProgress(hostKey),
  };
}
