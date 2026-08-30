/** PISKIE's handwritten declarations for the vendored channel surface. */
import type {
  QrLoginCancelResult,
  QrLoginStartResult,
  QrLoginSubmitCodeResult,
  QrLoginWaitResult,
} from '@shared/types/im-gateway.js';

export interface WeixinResolvedAccount {
  accountId: string;
  configured: boolean;
  token?: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  config: Record<string, unknown>;
}

interface PluginLog {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export const weixinPlugin: {
  id: string;
  config: {
    resolveAccount: (cfg: Record<string, unknown>, accountId?: string) => WeixinResolvedAccount;
  };
  gateway: {
    startAccount: (ctx: {
      cfg: Record<string, unknown>;
      accountId: string;
      account: WeixinResolvedAccount;
      runtime: Record<string, unknown>;
      channelRuntime: Record<string, unknown>;
      abortSignal?: AbortSignal;
      setStatus?: (next: Record<string, unknown>) => void;
      getStatus?: () => Record<string, unknown>;
      log?: PluginLog;
    }) => Promise<void>;
    stopAccount: (ctx: {
      account: WeixinResolvedAccount;
      timeoutMs?: number;
    }) => Promise<void>;
    loginWithQrStart: (opts: {
      accountId: string;
      credentialAccountId?: string;
      force?: boolean;
      timeoutMs?: number;
      verbose?: boolean;
    }) => Promise<QrLoginStartResult & { sessionKey?: string }>;
    loginWithQrWait: (opts: {
      accountId: string;
      credentialAccountId?: string;
      timeoutMs?: number;
      sessionKey?: string;
    }) => Promise<QrLoginWaitResult & { accountId?: string }>;
    loginWithQrSubmitCode: (opts: {
      accountId: string;
      sessionKey?: string;
      code: string;
    }) => Promise<QrLoginSubmitCodeResult>;
    loginWithQrCancel: (opts: {
      accountId: string;
      sessionKey?: string;
    }) => Promise<QrLoginCancelResult>;
  };
};
