import fs from "node:fs";
import path from "node:path";
import { normalizeAccountId } from "../../../../../core/openclaw-compat/account-id.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { resolveFrameworkAllowFromPath } from "./pairing.js";
import { logger } from "../util/logger.js";
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
// PISKIE 本地改动：状态根由宿主注入（<userData>/im-gateway/weixin），目录内不再有
// `openclaw-weixin` 子层级；raw-ID / legacy credentials / openclaw.json 回退分支全部移除，
// 因为 Piskie 专属目录里不存在旧数据，也不迁移旧 OpenClaw 数据。
// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------
function resolveWeixinStateDir() {
    return resolveStateDir();
}
function resolveAccountIndexPath() {
    return path.join(resolveWeixinStateDir(), "accounts.json");
}
/** Returns all accountIds registered via QR login. */
export function listIndexedWeixinAccountIds() {
    const filePath = resolveAccountIndexPath();
    try {
        if (!fs.existsSync(filePath))
            return [];
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((id) => typeof id === "string" && id.trim() !== "");
    }
    catch {
        return [];
    }
}
/** Add accountId to the persistent index (no-op if already present). */
export function registerWeixinAccountId(accountId) {
    const dir = resolveWeixinStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const existing = listIndexedWeixinAccountIds();
    if (existing.includes(accountId))
        return;
    const updated = [...existing, accountId];
    fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}
/** Remove accountId from the persistent index. */
export function unregisterWeixinAccountId(accountId) {
    const existing = listIndexedWeixinAccountIds();
    const normalized = normalizeAccountId(accountId);
    const updated = existing.filter((id) => normalizeAccountId(id) !== normalized);
    if (updated.length !== existing.length) {
        fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
    }
}
/**
 * Remove stale accounts that share the same userId as the newly-bound account.
 * Called after a successful QR login to ensure only the latest account remains
 * for a given WeChat user, preventing ambiguous contextToken matches.
 *
 * @param onClearContextTokens callback to clear context tokens for the removed account
 */
export function clearStaleAccountsForUserId(currentAccountId, userId, onClearContextTokens) {
    if (!userId)
        return;
    const allIds = listIndexedWeixinAccountIds();
    for (const id of allIds) {
        if (id === currentAccountId)
            continue;
        const data = loadWeixinAccount(id);
        if (data?.userId?.trim() === userId) {
            logger.info(`clearStaleAccountsForUserId: removing stale account=${id} (same userId=${userId})`);
            onClearContextTokens?.(id);
            clearWeixinAccount(id);
            unregisterWeixinAccountId(id);
        }
    }
}
function resolveAccountsDir() {
    return path.join(resolveWeixinStateDir(), "accounts");
}
function resolveAccountPath(accountId) {
    return path.join(resolveAccountsDir(), `${accountId}.json`);
}
function readAccountFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, "utf-8"));
        }
    }
    catch {
        // ignore
    }
    return null;
}
/** Load account data by ID from the Piskie-owned accounts dir (no legacy fallbacks). */
export function loadWeixinAccount(accountId) {
    return readAccountFile(resolveAccountPath(accountId));
}
/**
 * Persist account data after QR login (merges into existing file).
 * - token: overwritten when provided.
 * - baseUrl: stored when non-empty; resolveWeixinAccount falls back to DEFAULT_BASE_URL.
 * - userId: set when `update.userId` is provided; omitted from file when cleared to empty.
 */
export function saveWeixinAccount(accountId, update) {
    const dir = resolveAccountsDir();
    fs.mkdirSync(dir, { recursive: true });
    const existing = loadWeixinAccount(accountId) ?? {};
    const token = update.token?.trim() || existing.token;
    const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
    const userId = update.userId !== undefined
        ? update.userId.trim() || undefined
        : existing.userId?.trim() || undefined;
    const data = {
        ...(token ? { token, savedAt: new Date().toISOString() } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(userId ? { userId } : {}),
    };
    const filePath = resolveAccountPath(accountId);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    try {
        fs.chmodSync(filePath, 0o600);
    }
    catch {
        // best-effort
    }
}
/**
 * Remove all files associated with an account:
 *   - accounts/{accountId}.json                  (credentials)
 *   - accounts/{accountId}.sync.json             (getUpdates sync buf)
 *   - accounts/{accountId}.context-tokens.json   (context tokens on disk)
 *   - authorization/{accountId}-allowFrom.json       (authorized users)
 */
export function clearWeixinAccount(accountId) {
    const dir = resolveAccountsDir();
    for (const suffix of [".json", ".sync.json", ".context-tokens.json"]) {
        try {
            fs.unlinkSync(path.join(dir, `${accountId}${suffix}`));
        }
        catch {
            // Missing files are an idempotent success.
        }
    }
    try {
        fs.unlinkSync(resolveFrameworkAllowFromPath(accountId));
    }
    catch {
        // Missing authorization files are an idempotent success.
    }
}
/**
 * PISKIE 本地改动：不再读取外部 OpenClaw 的 openclaw.json（`OPENCLAW_CONFIG` / `<stateDir>/openclaw.json`）。
 * routeTag / botAgent 一律返回 undefined，调用方（api.js `sanitizeBotAgent`）据此使用内置默认值。
 */
export function loadConfigRouteTag(_accountId) {
    return undefined;
}
export function loadConfigBotAgent() {
    return undefined;
}
/** PISKIE persists login changes itself and does not consume OpenClaw reload timestamps. */
export async function triggerWeixinChannelReload() {
    // PISKIE persists the plugin account ID in BotConfig and does not consume
    // OpenClaw's config reload timestamp.
}
/** List accountIds from the index file (written at QR login). */
export function listWeixinAccountIds(_cfg) {
    return listIndexedWeixinAccountIds();
}
/** Resolve a weixin account by ID, merging config and stored credentials. */
export function resolveWeixinAccount(cfg, accountId) {
    const raw = accountId?.trim();
    if (!raw) {
        throw new Error("weixin: accountId is required (no default account)");
    }
    const id = normalizeAccountId(raw);
    const section = cfg.channels?.["openclaw-weixin"];
    const accountCfg = section?.accounts?.[id] ?? section ?? {};
    const accountData = loadWeixinAccount(id);
    const token = accountData?.token?.trim() || undefined;
    const stateBaseUrl = accountData?.baseUrl?.trim() || "";
    return {
        accountId: id,
        baseUrl: stateBaseUrl || DEFAULT_BASE_URL,
        cdnBaseUrl: accountCfg.cdnBaseUrl?.trim() || CDN_BASE_URL,
        token,
        enabled: accountCfg.enabled !== false,
        configured: Boolean(token),
        name: accountCfg.name?.trim() || undefined,
    };
}
