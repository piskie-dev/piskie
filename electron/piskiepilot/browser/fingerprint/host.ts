/**
 * host-key 与缓存路径的共享元信息。
 * 单列一处避免 binary.ts ↔ downloader.ts 循环依赖(两者都要 HOST_EXE / 缓存路径)。
 */
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { getFingerprintBinDir } from '@electron/piskiepilot/paths.js';

/** 当前宿主 host key,如 darwin-arm64 / win32-x64 / linux-x64 */
export const HOST_KEY = `${platform()}-${arch()}`;

/** host key → 缓存目录内可执行文件的相对路径(下载解压后须落在此) */
export const HOST_EXE: Record<string, string> = {
  'darwin-arm64': 'Chromium.app/Contents/MacOS/Chromium',
  'darwin-x64': 'Chromium.app/Contents/MacOS/Chromium',
  'linux-x64': 'chrome',
  'win32-x64': 'chrome.exe',
};

/** 该 host 的缓存根目录 <fingerprintBinDir>/<hostKey> */
export function cacheHostDir(hostKey: string = HOST_KEY): string {
  return join(getFingerprintBinDir(), hostKey);
}

/** 缓存目录内该 host 的期望可执行路径(未必存在);无 host 映射返回 null */
export function cacheExecPath(hostKey: string = HOST_KEY): string | null {
  const rel = HOST_EXE[hostKey];
  if (!rel) return null;
  return join(cacheHostDir(hostKey), rel);
}
