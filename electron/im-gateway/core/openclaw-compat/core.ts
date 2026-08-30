/**
 * 上游：openclaw src/channels/plugins/config-helpers.ts + setup-helpers.ts（MIT）
 * 消费方：qqbot vendor channel.js（顶层 import，实际仅 openclaw setup wizard 路径调用——
 * PISKIE 不触发，但 import 必须可解析、函数必须存在）
 */

import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from './account-id.js';

type OpenClawConfig = { channels?: Record<string, unknown> } & Record<string, unknown>;
type ChannelSection = {
  accounts?: Record<string, Record<string, unknown>>;
  enabled?: boolean;
};

export function setAccountEnabledInConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): OpenClawConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const base = params.cfg.channels?.[params.sectionKey] as ChannelSection | undefined;
  const hasAccounts = Boolean(base?.accounts);
  if (params.allowTopLevel && accountKey === DEFAULT_ACCOUNT_ID && !hasAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: { ...base, enabled: params.enabled },
      },
    };
  }

  const baseAccounts = base?.accounts ?? {};
  const existing = baseAccounts[accountKey] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.sectionKey]: {
        ...base,
        accounts: {
          ...baseAccounts,
          [accountKey]: { ...existing, enabled: params.enabled },
        },
      },
    },
  };
}

export function deleteAccountFromConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): OpenClawConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const base = params.cfg.channels?.[params.sectionKey] as ChannelSection | undefined;
  if (!base) {
    return params.cfg;
  }

  const baseAccounts =
    base.accounts && typeof base.accounts === 'object' ? { ...base.accounts } : undefined;

  if (accountKey !== DEFAULT_ACCOUNT_ID) {
    const accounts = baseAccounts ? { ...baseAccounts } : {};
    delete accounts[accountKey];
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...base,
          accounts: Object.keys(accounts).length ? accounts : undefined,
        },
      },
    };
  }

  if (baseAccounts && Object.keys(baseAccounts).length > 0) {
    delete baseAccounts[accountKey];
    const baseRecord = { ...(base as Record<string, unknown>) };
    for (const field of params.clearBaseFields ?? []) {
      if (field in baseRecord) {
        baseRecord[field] = undefined;
      }
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...baseRecord,
          accounts: Object.keys(baseAccounts).length ? baseAccounts : undefined,
        },
      },
    };
  }

  const nextChannels = { ...params.cfg.channels };
  delete nextChannels[params.sectionKey];
  const nextCfg = { ...params.cfg };
  if (Object.keys(nextChannels).length > 0) {
    nextCfg.channels = nextChannels;
  } else {
    delete nextCfg.channels;
  }
  return nextCfg;
}

/**
 * PISKIE 简化：上游经 shouldStoreNameInAccounts 决定名字写顶层还是 accounts；
 * 此处统一：default 账户无 accounts 时写顶层，否则写 accounts（等效于常见路径）
 */
export function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return params.cfg;
  }
  const accountId = normalizeAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
  const base = (params.cfg.channels?.[params.channelKey] ?? {}) as ChannelSection;
  const useAccounts = params.alwaysUseAccounts || accountId !== DEFAULT_ACCOUNT_ID || Boolean(base.accounts);
  if (!useAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: { ...base, name: trimmed },
      },
    };
  }
  const accounts = base.accounts ?? {};
  const existing = accounts[accountId] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...base,
        accounts: { ...accounts, [accountId]: { ...existing, name: trimmed } },
      },
    },
  };
}
