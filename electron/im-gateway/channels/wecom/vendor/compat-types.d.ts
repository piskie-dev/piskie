/**
 * PISKIE 收编：原 openclaw plugin-sdk 类型的本地替身
 *
 * 只保留 vendor 代码实际使用的形状：
 * - RuntimeEnv：日志载体（monitor 等文件以 runtime.log?.()/runtime.error?.() 消费）
 * - ResolvedWeComAccount：账户配置（原 utils.js 的 resolveWeComAccount 返回值，
 *   现由 ../account.ts 从 MessagingConnectionConfig 派生）
 */

export type RuntimeEnv = {
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type { WeComAccount as ResolvedWeComAccount } from '../account.js';
