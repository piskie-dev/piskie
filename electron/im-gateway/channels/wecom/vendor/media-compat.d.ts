/**
 * 媒体处理兼容层（PISKIE 收编版，原名 openclaw-compat.d.ts）
 * SDK 探测已删除，全部为本地实现；声明与 media-compat.js 实际导出对齐。
 */
export declare const DEFAULT_ACCOUNT_ID = "default";
/** 与 openclaw plugin-sdk 中 WebMediaResult 兼容的类型 */
export type WebMediaResult = {
    buffer: Buffer;
    contentType?: string;
    kind?: string;
    fileName?: string;
};
export type OutboundMediaLoadOptions = {
    maxBytes?: number;
    mediaLocalRoots?: readonly string[];
};
export type DetectMimeOptions = {
    buffer?: Buffer;
    headerMime?: string | null;
    filePath?: string;
};
/**
 * 检测 MIME 类型（兼容入口）
 *
 * 支持两种调用签名以兼容不同使用场景：
 * - detectMime(buffer)           → 旧式调用
 * - detectMime({ buffer, headerMime, filePath }) → 完整参数
 *
 * 优先使用 SDK 版本，不可用时使用 fallback。
 */
export declare function detectMime(bufferOrOpts: Buffer | DetectMimeOptions): Promise<string | undefined>;
/**
 * 从 URL 或本地路径加载媒体文件（兼容入口）
 *
 * 优先使用 SDK 版本，不可用时使用 fallback。
 * SDK 版本抛出的业务异常（如 LocalMediaAccessError）会直接透传。
 */
export declare function loadOutboundMediaFromUrl(mediaUrl: string, options?: OutboundMediaLoadOptions): Promise<WebMediaResult>;
/**
 * 向 allowFrom 列表添加通配符 "*"（兼容入口）
 *
 * 当 dmPolicy 为 "open" 时，需要确保 allowFrom 中包含 "*" 以允许所有来源。
 * 优先使用 SDK 版本（plugin-sdk/setup 或 plugin-sdk/core），不可用时使用 fallback。
 *
 * 注意：此函数为同步函数，与 SDK 原始签名一致。
 * SDK 引用在模块加载时异步探测并缓存，调用时同步读取缓存。
 */
export declare function addWildcardAllowFrom(allowFrom: string[]): string[];
/**
 * 获取默认媒体本地路径白名单（兼容入口）
 *
 * 优先使用 SDK 版本，不可用时手动构建白名单（与 weclaw/src/media/local-roots.ts 逻辑一致）。
 */
export declare function getDefaultMediaLocalRoots(): Promise<readonly string[]>;
export declare function emptyPluginConfigSchema(): Record<string, unknown>;
/** 从远程 URL 获取媒体（buffer 语义），失败抛错 */
export declare function fetchRemoteMedia(url: string, maxBytes?: number): Promise<{
    buffer: Buffer;
    contentType?: string;
    fileName?: string;
}>;
/**
 * 格式化配对审批提示信息（参考 moltbot 实现）
 * @param channelId 频道ID
 * @returns 配对审批提示字符串
 */
export declare function formatPairingApproveHint(channelId: string): string;
