import { pathToFileURL } from 'url';
import { platform } from 'os';

/**
 * 将文件系统路径转换为适合 import() 的格式
 *
 * @param filePath - 文件系统绝对路径
 * @returns import() 可用的路径/URL
 */
export function toImportPath(filePath: string): string {
  // Windows 需要使用 file:// URL
  if (platform() === 'win32') {
    return pathToFileURL(filePath).href;
  }

  // macOS/Linux 保持原样
  return filePath;
}
