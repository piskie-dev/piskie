"use strict";
/**
 * PISKIE 本地改动：飞书 UAT 凭据的存放位置由宿主注入。
 *
 * 上游 token-store 在模块加载时按 XDG_DATA_HOME / %LOCALAPPDATA% 推导
 * `openclaw-feishu-uat` 目录，macOS 用同名 Keychain service，与独立 OpenClaw 共用凭据。
 * Piskie 在创建 Connector 时注入 `<userData>/im-gateway/feishu/credentials` 与
 * service `piskie-feishu-uat`；未注入即抛错，绝不回退到旧目录/旧 service，也不迁移旧凭据。
 *
 * 状态挂在 globalThis（Symbol.for 键）上：本文件是 CJS，宿主 TS 经 ESM import 加载、
 * vendor 内部经 require 加载，某些加载器（如 vitest）会产生两个模块实例，进程级状态可避免注入丢失。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureFeishuTokenStore = configureFeishuTokenStore;
exports.requireFeishuTokenStoreLocation = requireFeishuTokenStoreLocation;
exports._resetFeishuTokenStoreForTest = _resetFeishuTokenStoreForTest;
const STATE_KEY = Symbol.for("piskie.im-gateway.feishu.token-store-location");
function readState() {
    const state = globalThis[STATE_KEY];
    return state && typeof state === "object" ? state : null;
}
function configureFeishuTokenStore(next) {
    const credentialsDir = typeof next?.credentialsDir === "string" ? next.credentialsDir.trim() : "";
    const keychainService = typeof next?.keychainService === "string" ? next.keychainService.trim() : "";
    if (!credentialsDir || !keychainService) {
        throw new Error("feishu: configureFeishuTokenStore requires credentialsDir and keychainService");
    }
    globalThis[STATE_KEY] = Object.freeze({ credentialsDir, keychainService });
}
function requireFeishuTokenStoreLocation() {
    const state = readState();
    if (!state) {
        throw new Error("feishu: token store location not configured — Piskie must call configureFeishuTokenStore() before use");
    }
    return state;
}
/** 仅供测试：清除注入。 */
function _resetFeishuTokenStoreForTest() {
    delete globalThis[STATE_KEY];
}
