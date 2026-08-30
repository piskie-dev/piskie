import fs from "node:fs";
import path from "node:path";
import { normalizeAccountId } from "../../../../../core/openclaw-compat/account-id.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { resolveFrameworkAllowFromPath } from "./pairing.js";
import { logger } from "../util/logger.js";
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
// ---------------------------------------------------------------------------
// Account ID compatibility (legacy raw ID → normalized ID)
// ---------------------------------------------------------------------------
/**
 * Pattern-based reverse of normalizeWeixinAccountId for known weixin ID suffixes.
 * Used only as a compatibility fallback when loading accounts / sync bufs stored
 * under the old raw ID.
 * e.g. "b0f5860fdecb-im-bot" → "b0f5860fdecb@im.bot"
 */
export function deriveRawAccountId(normalizedId) {
    if (normalizedId.endsWith("-im-bot")) {
        return `${normalizedId.slice(0, -7)}@im.bot`;
    }
    if (normalizedId.endsWith("-im-wechat")) {
        return `${normalizedId.slice(0, -10)}@im.wechat`;
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------
function resolveWeixinStateDir() {
    return path.join(resolveStateDir(), "openclaw-weixin");
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
/**
 * Legacy single-file token: `credentials/openclaw-weixin/credentials.json` (pre per-account files).
 */
function resolveLegacyCredentialPath() {
    return path.join(resolveStateDir(), "credentials", "openclaw-weixin", "credentials.json");
}
function loadLegacyToken() {
    const legacyPath = resolveLegacyCredentialPath();
    try {
        if (!fs.existsSync(legacyPath))
            return undefined;
        const raw = fs.readFileSync(legacyPath, "utf-8");
        const parsed = JSON.parse(raw);
        return typeof parsed.token === "string" ? parsed.token : undefined;
    }
    catch {
        return undefined;
    }
}
function hasAccountFile(accountId) {
    if (fs.existsSync(resolveAccountPath(accountId)))
        return true;
    const rawId = deriveRawAccountId(accountId);
    return Boolean(rawId && fs.existsSync(resolveAccountPath(rawId)));
}
export function isUsingLegacyWeixinCredential(accountId) {
    return !hasAccountFile(accountId) && Boolean(loadLegacyToken());
}
export function clearLegacyWeixinCredential() {
    try {
        fs.unlinkSync(resolveLegacyCredentialPath());
    }
    catch {
        // Missing legacy credentials are an idempotent success.
    }
    try {
        fs.unlinkSync(path.join(resolveStateDir(), "agents", "default", "sessions", ".openclaw-weixin-sync", "default.json"));
    }
    catch {
        // The legacy sync cursor may never have existed.
    }
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
/** Load account data by ID, with compatibility fallbacks. */
export function loadWeixinAccount(accountId) {
    // Primary: try given accountId (normalized IDs written after this change).
    const primary = readAccountFile(resolveAccountPath(accountId));
    if (primary)
        return primary;
    // Compatibility: if the given ID is normalized, derive the old raw filename
    // (e.g. "b0f5860fdecb-im-bot" → "b0f5860fdecb@im.bot") for existing installs.
    const rawId = deriveRawAccountId(accountId);
    if (rawId) {
        const compat = readAccountFile(resolveAccountPath(rawId));
        if (compat)
            return compat;
    }
    // Legacy fallback: read token from old single-account credentials file.
    const token = loadLegacyToken();
    if (token)
        return { token };
    return null;
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
 *   - credentials/openclaw-weixin-{accountId}-allowFrom.json (authorized users)
 */
export function clearWeixinAccount(accountId) {
    const dir = resolveAccountsDir();
    const accountIds = new Set([accountId]);
    const rawId = deriveRawAccountId(accountId);
    if (rawId)
        accountIds.add(rawId);
    for (const id of accountIds) {
        for (const suffix of [".json", ".sync.json", ".context-tokens.json"]) {
            try {
                fs.unlinkSync(path.join(dir, `${id}${suffix}`));
            }
            catch {
                // Missing files are an idempotent success.
            }
        }
        try {
            fs.unlinkSync(resolveFrameworkAllowFromPath(id));
        }
        catch {
            // Missing authorization files are an idempotent success.
        }
    }
}
/**
 * Resolve the openclaw.json config file path.
 * Checks OPENCLAW_CONFIG env var, then state dir.
 */
function resolveConfigPath() {
    const envPath = process.env.OPENCLAW_CONFIG?.trim();
    if (envPath)
        return envPath;
    return path.join(resolveStateDir(), "openclaw.json");
}
/**
 * Read `routeTag` from openclaw.json (for callers without an `OpenClawConfig` object).
 * Checks per-account `channels.<id>.accounts[accountId].routeTag` first, then section-level
 * `channels.<id>.routeTag`. Matches `feat_weixin_extension` behavior; channel key is `"openclaw-weixin"`.
 *
 * The config is cached after the first read since routeTag does not change at runtime.
 */
let cachedRouteTagSection;
function loadRouteTagSection() {
    if (cachedRouteTagSection !== undefined)
        return cachedRouteTagSection;
    try {
        const configPath = resolveConfigPath();
        if (!fs.existsSync(configPath)) {
            cachedRouteTagSection = null;
            return null;
        }
        const raw = fs.readFileSync(configPath, "utf-8");
        const cfg = JSON.parse(raw);
        const channels = cfg.channels;
        const section = channels?.["openclaw-weixin"] ?? null;
        cachedRouteTagSection = section;
        return section;
    }
    catch {
        cachedRouteTagSection = null;
        return null;
    }
}
export function loadConfigRouteTag(accountId) {
    const section = loadRouteTagSection();
    if (!section)
        return undefined;
    if (accountId) {
        const accounts = section.accounts;
        const tag = accounts?.[accountId]?.routeTag;
        if (typeof tag === "number")
            return String(tag);
        if (typeof tag === "string" && tag.trim())
            return tag.trim();
    }
    if (typeof section.routeTag === "number")
        return String(section.routeTag);
    return typeof section.routeTag === "string" && section.routeTag.trim()
        ? section.routeTag.trim()
        : undefined;
}
/**
 * Read `botAgent` from `channels.openclaw-weixin.botAgent` in openclaw.json.
 * Returns the raw configured string (caller is responsible for sanitization)
 * or undefined when not set. Reuses the cached channel section.
 */
export function loadConfigBotAgent() {
    const section = loadRouteTagSection();
    if (!section)
        return undefined;
    const value = section.botAgent;
    return typeof value === "string" && value.trim() ? value : undefined;
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
