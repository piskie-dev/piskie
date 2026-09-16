/**
 * PISKIE 本地改动：微信状态根由宿主注入，不再推导 OpenClaw 目录。
 *
 * 上游按 `OPENCLAW_STATE_DIR` / `CLAWDBOT_STATE_DIR` / `~/.openclaw` 解析状态根，
 * 与同机独立 OpenClaw 共用凭据与状态。Piskie 在创建 Connector 时把
 * `<userData>/im-gateway/weixin` 与 `<tmpdir>/piskie-im/weixin` 注入到这里；
 * 未注入即抛错，绝不回退到用户主目录或环境变量。
 */
let configured = null;
/** 由 Piskie 渠道工厂在任何 Connector 使用前调用（长期连接与扫码/退出临时实例一致）。 */
export function configureWeixinStorage(next) {
    const stateDir = typeof next?.stateDir === "string" ? next.stateDir.trim() : "";
    const tempDir = typeof next?.tempDir === "string" ? next.tempDir.trim() : "";
    if (!stateDir || !tempDir) {
        throw new Error("weixin: configureWeixinStorage requires stateDir and tempDir");
    }
    configured = { stateDir, tempDir };
}
function requireConfigured() {
    if (!configured) {
        throw new Error("weixin: storage location not configured — Piskie must call configureWeixinStorage() before use");
    }
    return configured;
}
/** Piskie 专属微信状态根（accounts.json、accounts/、authorization/、debug-mode.json）。 */
export function resolveStateDir() {
    return requireConfigured().stateDir;
}
/** Piskie 专属微信临时目录（出站媒体下载/转换）。 */
export function resolveWeixinTempDir() {
    return requireConfigured().tempDir;
}
/** 仅供测试：清除注入，验证未配置即拒绝访问。 */
export function _resetWeixinStorageForTest() {
    configured = null;
}
