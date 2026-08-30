import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveStateDir } from './state-dir-resolve.js';

/**
 * 媒体处理兼容层（PISKIE 收编版，原名 openclaw-compat.js）
 *
 * 上游在此动态探测 openclaw plugin-sdk 高版本导出，探测失败时使用文件内自带的
 * fallback 实现。PISKIE 收编后不存在 SDK，探测逻辑已删除，固定走 fallback
 * （fallback 即上游 weclaw 同源实现，功能完整）。
 * 上游对照：@wecom/wecom-openclaw-plugin@2026.4.2 dist/esm/src/openclaw-compat.js
 */
const DEFAULT_ACCOUNT_ID = "default";
// ============================================================================
// detectMime —— 检测 MIME 类型
// ============================================================================
const MIME_BY_EXT = {
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/x-m4a",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/vnd.rar",
    ".doc": "application/msword",
    ".xls": "application/vnd.ms-excel",
    ".ppt": "application/vnd.ms-powerpoint",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".amr": "audio/amr",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
};
/** 通过 buffer 魔术字节嗅探 MIME 类型（动态导入 file-type，不强依赖） */
async function sniffMimeFromBuffer(buffer) {
    try {
        const { fileTypeFromBuffer } = await import('file-type');
        const type = await fileTypeFromBuffer(buffer);
        return type?.mime ?? undefined;
    }
    catch {
        return undefined;
    }
}
/** fallback 版 detectMime，参考 weclaw/src/media/mime.ts */
async function detectMimeFallback(opts) {
    const ext = opts.filePath ? path.extname(opts.filePath).toLowerCase() : undefined;
    const extMime = ext ? MIME_BY_EXT[ext] : undefined;
    const sniffed = opts.buffer ? await sniffMimeFromBuffer(opts.buffer) : undefined;
    const isGeneric = (m) => !m || m === "application/octet-stream" || m === "application/zip";
    if (sniffed && (!isGeneric(sniffed) || !extMime)) {
        return sniffed;
    }
    if (extMime) {
        return extMime;
    }
    const headerMime = opts.headerMime?.split(";")?.[0]?.trim().toLowerCase();
    if (headerMime && !isGeneric(headerMime)) {
        return headerMime;
    }
    if (sniffed) {
        return sniffed;
    }
    if (headerMime) {
        return headerMime;
    }
    return undefined;
}
/**
 * 检测 MIME 类型（兼容入口）
 *
 * 支持两种调用签名以兼容不同使用场景：
 * - detectMime(buffer)           → 旧式调用
 * - detectMime({ buffer, headerMime, filePath }) → 完整参数
 *
 * 优先使用 SDK 版本，不可用时使用 fallback。
 */
async function detectMime(bufferOrOpts) {
    const opts = Buffer.isBuffer(bufferOrOpts)
        ? { buffer: bufferOrOpts }
        : bufferOrOpts;
    return detectMimeFallback(opts);
}
// ============================================================================
// loadOutboundMediaFromUrl —— 从 URL/路径加载媒体文件
// ============================================================================
/** 安全的本地文件路径校验，参考 weclaw/src/web/media.ts */
async function assertLocalMediaAllowed(mediaPath, localRoots) {
    if (!localRoots || localRoots.length === 0) {
        throw new Error(`Local media path is not under an allowed directory: ${mediaPath}`);
    }
    let resolved;
    try {
        resolved = await fs.realpath(mediaPath);
    }
    catch {
        resolved = path.resolve(mediaPath);
    }
    for (const root of localRoots) {
        let resolvedRoot;
        try {
            resolvedRoot = await fs.realpath(root);
        }
        catch {
            resolvedRoot = path.resolve(root);
        }
        if (resolvedRoot === path.parse(resolvedRoot).root) {
            continue;
        }
        if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) {
            return;
        }
    }
    throw new Error(`Local media path is not under an allowed directory: ${mediaPath}`);
}
/** 从远程 URL 获取媒体 */
async function fetchRemoteMedia(url, maxBytes) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
        throw new Error(`Failed to fetch media from ${url}: HTTP ${res.status} ${res.statusText}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buffer.length > maxBytes) {
        throw new Error(`Media from ${url} exceeds max size (${buffer.length} > ${maxBytes})`);
    }
    const headerMime = res.headers.get("content-type")?.split(";")?.[0]?.trim();
    let fileName;
    const disposition = res.headers.get("content-disposition");
    if (disposition) {
        const match = /filename\*?\s*=\s*(?:UTF-8''|")?([^";]+)/i.exec(disposition);
        if (match?.[1]) {
            try {
                fileName = path.basename(decodeURIComponent(match[1].replace(/["']/g, "").trim()));
            }
            catch {
                fileName = path.basename(match[1].replace(/["']/g, "").trim());
            }
        }
    }
    if (!fileName) {
        try {
            const parsed = new URL(url);
            const base = path.basename(parsed.pathname);
            if (base && base.includes("."))
                fileName = base;
        }
        catch { /* ignore */ }
    }
    const contentType = await detectMimeFallback({ buffer, headerMime, filePath: fileName ?? url });
    return { buffer, contentType, fileName };
}
/** 展开 ~ 为用户主目录 */
function resolveUserPath(p) {
    if (p.startsWith("~")) {
        return path.join(os.homedir(), p.slice(1));
    }
    return p;
}
/** fallback 版 loadOutboundMediaFromUrl，参考 weclaw/src/web/media.ts */
async function loadOutboundMediaFromUrlFallback(mediaUrl, options = {}) {
    const { maxBytes, mediaLocalRoots } = options;
    // 去除 MEDIA: 前缀
    mediaUrl = mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
    // 处理 file:// URL
    if (mediaUrl.startsWith("file://")) {
        try {
            mediaUrl = fileURLToPath(mediaUrl);
        }
        catch {
            throw new Error(`Invalid file:// URL: ${mediaUrl}`);
        }
    }
    // 远程 URL
    if (/^https?:\/\//i.test(mediaUrl)) {
        const fetched = await fetchRemoteMedia(mediaUrl, maxBytes);
        return {
            buffer: fetched.buffer,
            contentType: fetched.contentType,
            fileName: fetched.fileName,
        };
    }
    // 展开 ~ 路径
    if (mediaUrl.startsWith("~")) {
        mediaUrl = resolveUserPath(mediaUrl);
    }
    // 本地文件：安全校验
    await assertLocalMediaAllowed(mediaUrl, mediaLocalRoots);
    // 读取本地文件
    let data;
    try {
        const stat = await fs.stat(mediaUrl);
        if (!stat.isFile()) {
            throw new Error(`Local media path is not a file: ${mediaUrl}`);
        }
        data = await fs.readFile(mediaUrl);
    }
    catch (err) {
        if (err?.code === "ENOENT") {
            throw new Error(`Local media file not found: ${mediaUrl}`);
        }
        throw err;
    }
    if (maxBytes && data.length > maxBytes) {
        throw new Error(`Local media exceeds max size (${data.length} > ${maxBytes})`);
    }
    const mime = await detectMimeFallback({ buffer: data, filePath: mediaUrl });
    const fileName = path.basename(mediaUrl) || undefined;
    return {
        buffer: data,
        contentType: mime,
        fileName,
    };
}
/**
 * 从 URL 或本地路径加载媒体文件（兼容入口）
 *
 * 优先使用 SDK 版本，不可用时使用 fallback。
 * SDK 版本抛出的业务异常（如 LocalMediaAccessError）会直接透传。
 */
async function loadOutboundMediaFromUrl(mediaUrl, options = {}) {
    return loadOutboundMediaFromUrlFallback(mediaUrl, options);
}
// ============================================================================
// addWildcardAllowFrom —— 向 allowFrom 列表添加通配符 "*"
// ============================================================================
/** fallback 版 addWildcardAllowFrom：确保列表中包含 "*" 通配符 */
function addWildcardAllowFromFallback(allowFrom) {
    if (allowFrom.includes("*")) {
        return allowFrom;
    }
    return [...allowFrom, "*"];
}
/**
 * 向 allowFrom 列表添加通配符 "*"（兼容入口）
 *
 * 当 dmPolicy 为 "open" 时，需要确保 allowFrom 中包含 "*" 以允许所有来源。
 * 优先使用 SDK 版本（plugin-sdk/setup 或 plugin-sdk/core），不可用时使用 fallback。
 *
 * 注意：此函数为同步函数，与 SDK 原始签名一致。
 * SDK 引用在模块加载时异步探测并缓存，调用时同步读取缓存。
 */
function addWildcardAllowFrom(allowFrom) {
    return addWildcardAllowFromFallback(allowFrom);
}
// ============================================================================
// getDefaultMediaLocalRoots —— 获取默认媒体本地路径白名单
// ============================================================================
/**
 * 获取默认媒体本地路径白名单（兼容入口）
 *
 * 优先使用 SDK 版本，不可用时手动构建白名单（与 weclaw/src/media/local-roots.ts 逻辑一致）。
 */
async function getDefaultMediaLocalRoots() {
    const stateDir = path.resolve(resolveStateDir());
    return [
        path.join(stateDir, "media"),
        path.join(stateDir, "agents"),
        path.join(stateDir, "workspace"),
        path.join(stateDir, "sandboxes"),
    ];
}
function emptyPluginConfigSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {},
    };
}
/**
 * 格式化配对审批提示信息（参考 moltbot 实现）
 * @param channelId 频道ID
 * @returns 配对审批提示字符串
 */
function formatPairingApproveHint(channelId) {
    const listCmd = `openclaw pairing list ${channelId}`;
    const approveCmd = `openclaw pairing approve ${channelId} <code>`;
    return `向 ${channelId} 机器人发送消息以完成配对审批（命令行：${listCmd} / ${approveCmd}）`;
}

export { DEFAULT_ACCOUNT_ID, addWildcardAllowFrom, detectMime, emptyPluginConfigSchema, fetchRemoteMedia, formatPairingApproveHint, getDefaultMediaLocalRoots, loadOutboundMediaFromUrl };
