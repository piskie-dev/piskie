/**
 * 上游：openclaw src/plugin-sdk/command-auth.ts（resolveSenderCommandAuthorization）
 * 及其依赖 src/security/dm-policy-shared.ts、src/channels/allow-from.ts、
 * src/plugin-sdk/group-access.ts、src/shared/string-normalization.ts（均 MIT）。
 * 模块名沿用 vendor require 的 "openclaw/plugin-sdk/zalouser"（上游从该入口 re-export）。
 * 消费方：feishu vendor messaging/inbound/handler.js（有效白名单合并 + 命令授权计算）
 */

type Entries = Array<string | number>;

function normalizeStringEntries(list?: ReadonlyArray<unknown>): string[] {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

function mergeDmAllowFromSources(params: {
  allowFrom?: Entries;
  storeAllowFrom?: Entries;
  dmPolicy?: string;
}): string[] {
  const storeEntries = params.dmPolicy === 'allowlist' ? [] : (params.storeAllowFrom ?? []);
  return [...(params.allowFrom ?? []), ...storeEntries]
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function resolveGroupAllowFromSources(params: {
  allowFrom?: Entries;
  groupAllowFrom?: Entries;
  fallbackToAllowFrom?: boolean;
}): string[] {
  const explicitGroupAllowFrom =
    Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : undefined;
  const scoped = explicitGroupAllowFrom
    ? explicitGroupAllowFrom
    : params.fallbackToAllowFrom === false
      ? []
      : (params.allowFrom ?? []);
  return scoped.map((value) => String(value).trim()).filter(Boolean);
}

function resolveEffectiveAllowFromLists(params: {
  allowFrom?: Entries | null;
  groupAllowFrom?: Entries | null;
  storeAllowFrom?: Entries | null;
  dmPolicy?: string | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
}): { effectiveAllowFrom: string[]; effectiveGroupAllowFrom: string[] } {
  const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : undefined;
  const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : undefined;
  const storeAllowFrom = Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : undefined;
  const effectiveAllowFrom = normalizeStringEntries(
    mergeDmAllowFromSources({
      allowFrom,
      storeAllowFrom,
      dmPolicy: params.dmPolicy ?? undefined,
    }),
  );
  // Group auth is explicit (groupAllowFrom fallback allowFrom). Pairing store is DM-only.
  const effectiveGroupAllowFrom = normalizeStringEntries(
    resolveGroupAllowFromSources({
      allowFrom,
      groupAllowFrom,
      fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
    }),
  );
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}

function resolveDmGroupAccessWithLists(params: {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  allowFrom?: Entries | null;
  groupAllowFrom?: Entries | null;
  storeAllowFrom?: Entries | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): { effectiveAllowFrom: string[]; effectiveGroupAllowFrom: string[] } {
  // PISKIE 简化：仅移植 lists 部分；decision/reason 未被 resolveSenderCommandAuthorization
  // 的返回值消费（其只读取 effectiveAllowFrom / effectiveGroupAllowFrom）
  return resolveEffectiveAllowFromLists({
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    storeAllowFrom: params.storeAllowFrom,
    dmPolicy: params.dmPolicy,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
  });
}

export type ResolveSenderCommandAuthorizationParams = {
  rawBody: string;
  cfg: { commands?: { useAccessGroups?: boolean } } & Record<string, unknown>;
  isGroup: boolean;
  dmPolicy: string;
  senderId: string;
  configuredAllowFrom: Entries;
  configuredGroupAllowFrom?: Entries;
  readAllowFromStore: () => Promise<string[]>;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  shouldComputeCommandAuthorized: (rawBody: string, cfg: unknown) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
};

/** Compute effective allowlists and command authorization for one inbound sender. */
export async function resolveSenderCommandAuthorization(
  params: ResolveSenderCommandAuthorizationParams,
): Promise<{
  shouldComputeAuth: boolean;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
}> {
  const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
  const storeAllowFrom =
    !params.isGroup &&
    params.dmPolicy !== 'allowlist' &&
    (params.dmPolicy !== 'open' || shouldComputeAuth)
      ? await params.readAllowFromStore().catch(() => [])
      : [];
  const access = resolveDmGroupAccessWithLists({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: 'allowlist',
    allowFrom: params.configuredAllowFrom,
    groupAllowFrom: params.configuredGroupAllowFrom ?? [],
    storeAllowFrom,
    isSenderAllowed: (allowFrom) => params.isSenderAllowed(params.senderId, allowFrom),
  });
  const effectiveAllowFrom = access.effectiveAllowFrom;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
  );
  const ownerAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveAllowFrom);
  const groupAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveGroupAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? params.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: ownerAllowedForCommands },
          { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
        ],
      })
    : undefined;
  return {
    shouldComputeAuth,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    senderAllowedForCommands,
    commandAuthorized,
  };
}
