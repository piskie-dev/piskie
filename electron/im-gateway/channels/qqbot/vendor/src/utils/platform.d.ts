export interface QQBotStorageConfig {
  dataDir: string;
  mediaDir: string;
}
export function configureQQBotStorage(next: QQBotStorageConfig): void;
export function _resetQQBotStorageForTest(): void;
export function getQQBotDataDir(...subPaths: string[]): string;
export function getQQBotMediaDir(...subPaths: string[]): string;
export function resolveQQBotMediaDir(...subPaths: string[]): string;
export function getHomeDir(): string;
export function getTempDir(): string;
export function isWindows(): boolean;
export function expandTilde(p: string): string;
export function normalizePath(p: string): string;
export function isLocalPath(p: string): boolean;
