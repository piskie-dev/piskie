import os from 'node:os';

export function expandHomePath(targetPath: string): string {
  if (targetPath === '~' || targetPath.startsWith('~/')) {
    return `${os.homedir()}${targetPath.slice(1)}`;
  }
  return targetPath;
}
