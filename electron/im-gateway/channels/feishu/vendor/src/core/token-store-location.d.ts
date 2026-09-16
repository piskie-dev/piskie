export interface FeishuTokenStoreLocation {
  credentialsDir: string;
  keychainService: string;
}
export function configureFeishuTokenStore(next: FeishuTokenStoreLocation): void;
export function requireFeishuTokenStoreLocation(): FeishuTokenStoreLocation;
export function _resetFeishuTokenStoreForTest(): void;
