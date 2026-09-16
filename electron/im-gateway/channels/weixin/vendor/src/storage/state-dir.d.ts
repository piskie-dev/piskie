export interface WeixinStorageConfig {
  stateDir: string;
  tempDir: string;
}
export function configureWeixinStorage(next: WeixinStorageConfig): void;
export function resolveStateDir(): string;
export function resolveWeixinTempDir(): string;
export function _resetWeixinStorageForTest(): void;
