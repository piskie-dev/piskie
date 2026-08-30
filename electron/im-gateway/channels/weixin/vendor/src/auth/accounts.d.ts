export function deriveRawAccountId(normalizedId: string): string | undefined;
export function isUsingLegacyWeixinCredential(accountId: string): boolean;
export function clearLegacyWeixinCredential(): void;
export function clearWeixinAccount(accountId: string): void;
export function unregisterWeixinAccountId(accountId: string): void;
