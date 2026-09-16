import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./state-dir.js";
function resolveAccountsDir() {
    return path.join(resolveStateDir(), "accounts");
}
/**
 * Path to the persistent get_updates_buf file for an account.
 * Stored alongside account data: <weixinStateDir>/accounts/{accountId}.sync.json
 */
export function getSyncBufFilePath(accountId) {
    return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}
function readSyncBufFile(filePath) {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw);
        if (typeof data.get_updates_buf === "string") {
            return data.get_updates_buf;
        }
    }
    catch {
        // file not found or invalid
    }
    return undefined;
}
/**
 * Load persisted get_updates_buf from the primary (normalized accountId) path.
 * PISKIE 本地改动：不再回退到 raw-ID 旧文件名或 OpenClaw 单账号 legacy 游标——
 * Piskie 目录内没有旧数据，游标缺失时按首次登录处理。
 */
export function loadGetUpdatesBuf(filePath) {
    return readSyncBufFile(filePath);
}
/**
 * Persist get_updates_buf. Creates parent dir if needed.
 */
export function saveGetUpdatesBuf(filePath, getUpdatesBuf) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 0), "utf-8");
}
