/**
 * QQ Bot API 鉴权和请求封装
 * [修复版] 已重构为支持多实例并发，消除全局变量冲突
 */
import os from "node:os";
import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "./utils/upload-cache.js";
import { sanitizeFileName } from "./utils/platform.js";
/** 默认使用 console，外部可通过 setApiLogger 注入框架 log */
let log = {
    info: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
    warn: (msg) => console.warn(msg),
    debug: (msg) => console.debug(msg),
};
/**
 * 注入自定义 logger（在 gateway 启动时调用，将 api 模块的日志统一接入框架日志系统）
 */
export function setApiLogger(logger) {
    log = logger;
}
// ============ 自定义错误 ============
/** API 请求错误，携带 HTTP status code 和业务错误码 */
export class ApiError extends Error {
    status;
    path;
    bizCode;
    bizMessage;
    constructor(message, status, path, 
    /** 业务错误码（回包中的 code / err_code 字段），不一定存在 */
    bizCode, 
    /** 回包中的原始 message 字段（用于向用户展示兜底文案） */
    bizMessage) {
        super(message);
        this.status = status;
        this.path = path;
        this.bizCode = bizCode;
        this.bizMessage = bizMessage;
        this.name = "ApiError";
    }
}
const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
// ============ Plugin User-Agent ============
// 格式: QQBotPlugin/{version} (Node/{nodeVersion}; {os}; OpenClaw/{openclawVersion})
// 示例: QQBotPlugin/1.6.0 (Node/22.14.0; darwin; OpenClaw/2026.3.31)
import { getPackageVersion } from "./utils/pkg-version.js";
const _pluginVersion = getPackageVersion(import.meta.url);
// 初始值为 "unknown"，由 setQQBotRuntime 注入后更新为真实版本
let _openclawVersion = "unknown";
/** 由 setQQBotRuntime 调用，将 api.runtime.version 注入到 User-Agent */
export function setOpenClawVersion(version) {
    if (version)
        _openclawVersion = version;
}
export function getPluginUserAgent() {
    return `QQBotPlugin/${_pluginVersion} (Node/${process.versions.node}; ${os.platform()}; OpenClaw/${_openclawVersion})`;
}
// 运行时配置
let currentMarkdownSupport = false;
let onMessageSentHook = null;
/**
 * 注册出站消息回调
 * 当消息发送成功且 QQ 返回 ref_idx 时，自动回调此函数
 * 用于在最底层统一缓存 bot 出站消息的 refIdx
 */
export function onMessageSent(callback) {
    onMessageSentHook = callback;
}
/**
 * 初始化 API 配置
 */
export function initApiConfig(options) {
    currentMarkdownSupport = options.markdownSupport === true;
}
/**
 * 获取当前是否支持 markdown
 */
export function isMarkdownSupport() {
    return currentMarkdownSupport;
}
// =========================================================================
// 🚀 [核心修复] 将全局状态改为 Map，按 appId 隔离，彻底解决多账号串号问题
// =========================================================================
const tokenCacheMap = new Map();
const tokenFetchPromises = new Map();
/**
 * 获取 AccessToken（带缓存 + singleflight 并发安全）
 *
 * 使用 singleflight 模式：当多个请求同时发现 Token 过期时，
 * 只有第一个请求会真正去获取新 Token，其他请求复用同一个 Promise。
 *
 * 按 appId 隔离，支持多机器人并发请求。
 */
export async function getAccessToken(appId, clientSecret) {
    const normalizedAppId = String(appId).trim();
    const cachedToken = tokenCacheMap.get(normalizedAppId);
    // 检查缓存：未过期时复用
    // 提前刷新阈值：取 expiresIn 的 1/3 和 5 分钟的较小值，避免短有效期 token 永远被判定过期
    const REFRESH_AHEAD_MS = cachedToken
        ? Math.min(5 * 60 * 1000, (cachedToken.expiresAt - Date.now()) / 3)
        : 0;
    if (cachedToken && Date.now() < cachedToken.expiresAt - REFRESH_AHEAD_MS) {
        return cachedToken.token;
    }
    // Singleflight: 如果当前 appId 已有进行中的 Token 获取请求，复用它
    let fetchPromise = tokenFetchPromises.get(normalizedAppId);
    if (fetchPromise) {
        log.info(`[qqbot-api:${normalizedAppId}] Token fetch in progress, waiting for existing request...`);
        return fetchPromise;
    }
    // 创建新的 Token 获取 Promise（singleflight 入口）
    fetchPromise = (async () => {
        try {
            return await doFetchToken(normalizedAppId, clientSecret);
        }
        finally {
            // 无论成功失败，都清除 Promise 缓存
            tokenFetchPromises.delete(normalizedAppId);
        }
    })();
    tokenFetchPromises.set(normalizedAppId, fetchPromise);
    return fetchPromise;
}
/**
 * 实际执行 Token 获取的内部函数
 */
async function doFetchToken(appId, clientSecret) {
    const requestBody = { appId, clientSecret };
    const requestHeaders = { "Content-Type": "application/json", "User-Agent": getPluginUserAgent() };
    // 打印请求信息（隐藏敏感信息）
    log.info(`[qqbot-api:${appId}] >>> POST ${TOKEN_URL} [secret: ${clientSecret.slice(0, 6)}...len=${clientSecret.length}]`);
    let response;
    try {
        response = await fetch(TOKEN_URL, {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(requestBody),
            // PISKIE 本地改动（49号 §3.2.1 abort 契约）：在途 I/O 必须有固定上限，
            // token 请求悬挂不能让启动/停止 barrier 无限等待
            signal: AbortSignal.timeout(30000),
        });
    }
    catch (err) {
        log.error(`[qqbot-api:${appId}] <<< Network error: ${err}`);
        throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 打印响应头
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });
    const tokenTraceId = response.headers.get("x-tps-trace-id") ?? "";
    log.info(`[qqbot-api:${appId}] <<< Status: ${response.status} ${response.statusText}${tokenTraceId ? ` | TraceId: ${tokenTraceId}` : ""}`);
    let data;
    let rawBody;
    try {
        rawBody = await response.text();
        // 隐藏 token 值
        const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
        log.info(`[qqbot-api:${appId}] <<< Body: ${logBody}`);
        data = JSON.parse(rawBody);
    }
    catch (err) {
        log.error(`[qqbot-api:${appId}] <<< Parse error: ${err}`);
        throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!data.access_token) {
        throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
    }
    const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    tokenCacheMap.set(appId, {
        token: data.access_token,
        expiresAt,
        appId,
    });
    log.info(`[qqbot-api:${appId}] Token cached, expires at: ${new Date(expiresAt).toISOString()}`);
    return data.access_token;
}
/**
 * 清除 Token 缓存
 * @param appId 选填。如果有，只清空特定账号的缓存；如果没有，清空所有账号。
 */
export function clearTokenCache(appId) {
    if (appId) {
        const normalizedAppId = String(appId).trim();
        tokenCacheMap.delete(normalizedAppId);
        log.info(`[qqbot-api:${normalizedAppId}] Token cache cleared manually.`);
    }
    else {
        tokenCacheMap.clear();
        log.info(`[qqbot-api] All token caches cleared.`);
    }
}
/**
 * 获取 Token 缓存状态（用于监控）
 */
export function getTokenStatus(appId) {
    if (tokenFetchPromises.has(appId)) {
        return { status: "refreshing", expiresAt: tokenCacheMap.get(appId)?.expiresAt ?? null };
    }
    const cached = tokenCacheMap.get(appId);
    if (!cached) {
        return { status: "none", expiresAt: null };
    }
    const remaining = cached.expiresAt - Date.now();
    const isValid = remaining > Math.min(5 * 60 * 1000, remaining / 3);
    return { status: isValid ? "valid" : "expired", expiresAt: cached.expiresAt };
}
/**
 * 获取全局唯一的消息序号（范围 0 ~ 65535）
 * 使用毫秒级时间戳低位 + 随机数异或混合，无状态，避免碰撞
 */
export function getNextMsgSeq(_msgId) {
    const timePart = Date.now() % 100000000; // 毫秒时间戳后8位
    const random = Math.floor(Math.random() * 65536); // 0~65535
    return (timePart ^ random) % 65536; // 异或混合后限制在 0~65535
}
// API 请求超时配置（毫秒）
const DEFAULT_API_TIMEOUT = 30000; // 默认 30 秒
const FILE_UPLOAD_TIMEOUT = 120000; // 文件上传 120 秒
/**
 * API 请求封装
 */
export async function apiRequest(accessToken, method, path, body, timeoutMs) {
    const url = `${API_BASE}${path}`;
    const reqTs = Date.now(); // 毫秒时间戳，用于关联同一次请求的所有日志
    const headers = {
        Authorization: `QQBot ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": getPluginUserAgent(),
    };
    const isFileUpload = path.includes("/files");
    const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeout);
    const options = {
        method,
        headers,
        signal: controller.signal,
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    // 打印请求信息
    log.info(`[qqbot-api][${reqTs}] >>> ${method} ${url} (timeout: ${timeout}ms)`);
    if (body) {
        const logBody = { ...body };
        if (typeof logBody.file_data === "string") {
            logBody.file_data = `<base64 ${logBody.file_data.length} chars>`;
        }
        log.info(`[qqbot-api][${reqTs}] >>> Body: ${JSON.stringify(logBody)}`);
    }
    let res;
    try {
        res = await fetch(url, options);
    }
    catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === "AbortError") {
            log.error(`[qqbot-api][${reqTs}] <<< Request timeout after ${timeout}ms`);
            throw new Error(`Request timeout[${path}]: exceeded ${timeout}ms`);
        }
        log.error(`[qqbot-api][${reqTs}] <<< Network error: ${err}`);
        throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`);
    }
    finally {
        clearTimeout(timeoutId);
    }
    const responseHeaders = {};
    res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });
    const traceId = res.headers.get("x-tps-trace-id") ?? "";
    log.info(`[qqbot-api][${reqTs}] <<< Status: ${res.status} ${res.statusText}${traceId ? ` | TraceId: ${traceId}` : ""}`);
    let rawBody;
    try {
        rawBody = await res.text();
    }
    catch (err) {
        throw new Error(`读取响应失败[${path}]: ${err instanceof Error ? err.message : String(err)}`);
    }
    log.info(`[qqbot-api][${reqTs}] <<< Body: ${rawBody}`);
    // 检测非 JSON 响应（HTML 网关错误页 / CDN 限流页等）
    const contentType = res.headers.get("content-type") ?? "";
    const isHtmlResponse = contentType.includes("text/html") || rawBody.trimStart().startsWith("<");
    if (!res.ok) {
        if (isHtmlResponse) {
            // HTML 响应 = 网关/限流层返回的错误页，给出友好提示
            const statusHint = res.status === 502 || res.status === 503 || res.status === 504
                ? "调用发生异常，请稍候重试"
                : res.status === 429
                    ? "请求过于频繁，已被限流"
                    : `开放平台返回 HTTP ${res.status}`;
            throw new ApiError(`${statusHint}（${path}），请稍后重试`, res.status, path);
        }
        // JSON 错误响应
        try {
            const error = JSON.parse(rawBody);
            const bizCode = error.code ?? error.err_code;
            throw new ApiError(`API Error [${path}]: ${error.message ?? rawBody}`, res.status, path, bizCode, error.message);
        }
        catch (parseErr) {
            if (parseErr instanceof ApiError)
                throw parseErr;
            throw new ApiError(`API Error [${path}] HTTP ${res.status}: ${rawBody.slice(0, 200)}`, res.status, path);
        }
    }
    // 成功响应但不是 JSON（极端异常情况）
    if (isHtmlResponse) {
        throw new ApiError(`QQ 服务端返回了非 JSON 响应（${path}），可能是临时故障，请稍后重试`, res.status, path);
    }
    try {
        return JSON.parse(rawBody);
    }
    catch {
        throw new ApiError(`开放平台响应格式异常（${path}），请稍后重试`, res.status, path);
    }
}
// ============ 上传重试（指数退避） ============
const UPLOAD_MAX_RETRIES = 2;
const UPLOAD_BASE_DELAY_MS = 1000;
async function apiRequestWithRetry(accessToken, method, path, body, maxRetries = UPLOAD_MAX_RETRIES) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await apiRequest(accessToken, method, path, body);
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const errMsg = lastError.message;
            if (errMsg.includes("400") || errMsg.includes("401") || errMsg.includes("Invalid") ||
                errMsg.includes("上传超时") || errMsg.includes("timeout") || errMsg.includes("Timeout")) {
                throw lastError;
            }
            if (attempt < maxRetries) {
                const delay = UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
                log.info(`[qqbot-api] Upload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${errMsg.slice(0, 100)}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}
// ============ 完成上传重试（无条件，任何错误都重试） ============
const COMPLETE_UPLOAD_MAX_RETRIES = 2;
const COMPLETE_UPLOAD_BASE_DELAY_MS = 2000;
/**
 * 完成上传专用重试：无条件重试所有错误（包括 4xx、5xx、网络错误、超时等）
 * 分片上传完成接口的失败往往是平台侧异步处理未就绪，重试通常能成功
 */
async function completeUploadWithRetry(accessToken, method, path, body) {
    let lastError = null;
    for (let attempt = 0; attempt <= COMPLETE_UPLOAD_MAX_RETRIES; attempt++) {
        try {
            return await apiRequest(accessToken, method, path, body);
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < COMPLETE_UPLOAD_MAX_RETRIES) {
                const delay = COMPLETE_UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
                (log.warn ?? log.error)(`[qqbot-api] CompleteUpload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message.slice(0, 200)}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}
// ============ 分片完成重试 ============
/** 普通错误最大重试次数 */
const PART_FINISH_MAX_RETRIES = 2;
const PART_FINISH_BASE_DELAY_MS = 1000;
/**
 * 需要持续重试的业务错误码集合
 * 当 upload_part_finish 返回这些错误码时，会以固定 1s 间隔持续重试直到成功或超时
 */
export const PART_FINISH_RETRYABLE_CODES = new Set([
    40093001,
]);
/**
 * upload_prepare 接口命中此错误码时，携带文件信息抛出 UploadDailyLimitExceededError，
 * 由上层（outbound.ts）构造包含文件路径和大小的兜底文案发送给用户，
 * 而非走通用的"文件发送失败，请稍后重试"
 */
export const UPLOAD_PREPARE_FALLBACK_CODE = 40093002;
/** 特定错误码持续重试的默认超时（服务端未返回 retry_timeout 时的兜底） */
const PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
/** 特定错误码重试的固定间隔（1 秒） */
const PART_FINISH_RETRYABLE_INTERVAL_MS = 1000;
/**
 * 判断错误是否命中"需要持续重试"的业务错误码
 */
function isRetryableBizCode(err) {
    if (PART_FINISH_RETRYABLE_CODES.size === 0)
        return false;
    if (err instanceof ApiError && err.bizCode !== undefined) {
        return PART_FINISH_RETRYABLE_CODES.has(err.bizCode);
    }
    return false;
}
/**
 * 分片完成接口重试策略：
 *
 * 1. 命中 PART_FINISH_RETRYABLE_CODES 的错误码 → 每 1s 重试一次，直到成功或超时
 *    超时时间 = min(API 返回的 retry_timeout, 10 分钟)
 * 2. 其他错误 → 最多重试 PART_FINISH_MAX_RETRIES 次（与之前逻辑一致）
 *
 * 若持续重试超时或普通重试耗尽，抛出错误，调用方（chunkedUpload）
 * 可据此中止后续分片上传。
 *
 * @param retryTimeoutMs - 持续重试的超时时间（毫秒），由 upload_prepare 返回的 retry_timeout 计算得出
 */
async function partFinishWithRetry(accessToken, method, path, body, retryTimeoutMs) {
    let lastError = null;
    for (let attempt = 0; attempt <= PART_FINISH_MAX_RETRIES; attempt++) {
        try {
            await apiRequest(accessToken, method, path, body);
            return;
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            // 命中特定错误码 → 进入持续重试模式
            if (isRetryableBizCode(err)) {
                const timeoutMs = retryTimeoutMs ?? PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS;
                (log.warn ?? log.error)(`[qqbot-api] PartFinish hit retryable bizCode=${err.bizCode}, entering persistent retry (timeout=${timeoutMs / 1000}s, interval=1s)...`);
                await partFinishPersistentRetry(accessToken, method, path, body, timeoutMs);
                return;
            }
            if (attempt < PART_FINISH_MAX_RETRIES) {
                const delay = PART_FINISH_BASE_DELAY_MS * Math.pow(2, attempt);
                (log.warn ?? log.error)(`[qqbot-api] PartFinish attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message.slice(0, 200)}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}
/**
 * 特定错误码的持续重试模式
 * 不限次数，仅受总超时时间约束，固定每 1 秒重试一次
 */
async function partFinishPersistentRetry(accessToken, method, path, body, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            await apiRequest(accessToken, method, path, body);
            log.info(`[qqbot-api] PartFinish persistent retry succeeded after ${attempt} retries`);
            return;
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            // 如果不再是可重试的错误码，直接抛出（可能是其他类型的错误）
            if (!isRetryableBizCode(err)) {
                log.error(`[qqbot-api] PartFinish persistent retry: error is no longer retryable (bizCode=${err.bizCode ?? "N/A"}), aborting`);
                throw lastError;
            }
            attempt++;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            const actualDelay = Math.min(PART_FINISH_RETRYABLE_INTERVAL_MS, remaining);
            (log.warn ?? log.error)(`[qqbot-api] PartFinish persistent retry #${attempt}: bizCode=${err.bizCode}, retrying in ${actualDelay}ms (remaining=${Math.round(remaining / 1000)}s)`);
            await new Promise(resolve => setTimeout(resolve, actualDelay));
        }
    }
    // 超时
    log.error(`[qqbot-api] PartFinish persistent retry timed out after ${timeoutMs / 1000}s (${attempt} attempts)`);
    throw new Error(`upload_part_finish 持续重试超时（${timeoutMs / 1000}s, ${attempt} 次重试），中止上传`);
}
export async function getGatewayUrl(accessToken) {
    const data = await apiRequest(accessToken, "GET", "/gateway");
    return data.url;
}
/** 回应按钮交互（INTERACTION_CREATE），避免客户端按钮持续 loading */
export async function acknowledgeInteraction(accessToken, interactionId, code = 0, data) {
    await apiRequest(accessToken, "PUT", `/interactions/${interactionId}`, { code, ...(data ? { data } : {}) });
}
/** 获取插件版本号（从 package.json 读取，和 getPluginUserAgent() 同源） */
export function getApiPluginVersion() {
    return _pluginVersion;
}
/**
 * 发送消息并自动触发 refIdx 回调
 * 所有消息发送函数统一经过此处，确保每条出站消息的 refIdx 都被捕获
 */
async function sendAndNotify(accessToken, method, path, body, meta) {
    const result = await apiRequest(accessToken, method, path, body);
    if (result.ext_info?.ref_idx && onMessageSentHook) {
        try {
            onMessageSentHook(result.ext_info.ref_idx, meta);
        }
        catch (err) {
            log.error(`[qqbot-api] onMessageSent hook error: ${err}`);
        }
    }
    return result;
}
function buildMessageBody(content, msgId, msgSeq, messageReference, inlineKeyboard) {
    const body = currentMarkdownSupport
        ? {
            markdown: { content },
            msg_type: 2,
            msg_seq: msgSeq,
        }
        : {
            content,
            msg_type: 0,
            msg_seq: msgSeq,
        };
    if (msgId) {
        body.msg_id = msgId;
    }
    if (messageReference && !currentMarkdownSupport) {
        body.message_reference = { message_id: messageReference };
    }
    // Inline Keyboard（内嵌按钮，需审核）：字段名 keyboard，结构 { content: { rows } }
    if (inlineKeyboard) {
        body.keyboard = inlineKeyboard;
    }
    return body;
}
export async function sendC2CMessage(accessToken, openid, content, msgId, messageReference) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    const body = buildMessageBody(content, msgId, msgSeq, messageReference);
    return sendAndNotify(accessToken, "POST", `/v2/users/${openid}/messages`, body, { text: content });
}
export async function sendC2CInputNotify(accessToken, openid, msgId, inputSecond = 60) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    const body = {
        msg_type: 6,
        input_notify: {
            input_type: 1,
            input_second: inputSecond,
        },
        msg_seq: msgSeq,
        ...(msgId ? { msg_id: msgId } : {}),
    };
    const response = await apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body);
    return { refIdx: response.ext_info?.ref_idx };
}
export async function sendChannelMessage(accessToken, channelId, content, msgId) {
    return apiRequest(accessToken, "POST", `/channels/${channelId}/messages`, {
        content,
        ...(msgId ? { msg_id: msgId } : {}),
    });
}
/**
 * 发送频道私信消息
 * @param guildId - 私信会话的 guild_id（由 DIRECT_MESSAGE_CREATE 事件提供）
 * @param msgId - 被动回复时必填
 */
export async function sendDmMessage(accessToken, guildId, content, msgId) {
    return apiRequest(accessToken, "POST", `/dms/${guildId}/messages`, {
        content,
        ...(msgId ? { msg_id: msgId } : {}),
    });
}
export async function sendGroupMessage(accessToken, groupOpenid, content, msgId, messageReference) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    const body = buildMessageBody(content, msgId, msgSeq, messageReference);
    return sendAndNotify(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body, { text: content });
}
/** 发送带 Inline Keyboard 的 C2C 消息（回调型按钮，触发 INTERACTION_CREATE） */
export async function sendC2CMessageWithInlineKeyboard(accessToken, openid, content, inlineKeyboard, msgId) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    const body = buildMessageBody(content, msgId, msgSeq, undefined, inlineKeyboard);
    return sendAndNotify(accessToken, "POST", `/v2/users/${openid}/messages`, body, { text: content });
}
/** 发送带 Inline Keyboard 的 Group 消息（回调型按钮，触发 INTERACTION_CREATE） */
export async function sendGroupMessageWithInlineKeyboard(accessToken, groupOpenid, content, inlineKeyboard, msgId) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    const body = buildMessageBody(content, msgId, msgSeq, undefined, inlineKeyboard);
    return sendAndNotify(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body, { text: content });
}
function buildProactiveMessageBody(content) {
    if (!content || content.trim().length === 0) {
        throw new Error("主动消息内容不能为空 (markdown.content is empty)");
    }
    if (currentMarkdownSupport) {
        return { markdown: { content }, msg_type: 2 };
    }
    else {
        return { content, msg_type: 0 };
    }
}
export async function sendProactiveC2CMessage(accessToken, openid, content) {
    const body = buildProactiveMessageBody(content);
    return sendAndNotify(accessToken, "POST", `/v2/users/${openid}/messages`, body, { text: content });
}
export async function sendProactiveGroupMessage(accessToken, groupOpenid, content) {
    const body = buildProactiveMessageBody(content);
    return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body);
}
// ============ 富媒体消息支持 ============
export var MediaFileType;
(function (MediaFileType) {
    MediaFileType[MediaFileType["IMAGE"] = 1] = "IMAGE";
    MediaFileType[MediaFileType["VIDEO"] = 2] = "VIDEO";
    MediaFileType[MediaFileType["VOICE"] = 3] = "VOICE";
    MediaFileType[MediaFileType["FILE"] = 4] = "FILE";
})(MediaFileType || (MediaFileType = {}));
/**
 * 申请上传（C2C）
 * POST /v2/users/{user_id}/upload_prepare
 *
 * @param accessToken - 访问令牌
 * @param userId - 用户 openid
 * @param fileType - 业务类型（1=图片, 2=视频, 3=语音, 4=文件）
 * @param fileName - 文件名
 * @param fileSize - 文件大小（字节）
 * @param hashes - 文件哈希信息（md5, sha1, md5_10m）
 * @returns 上传任务 ID、分块大小、分片预签名链接列表
 */
export async function c2cUploadPrepare(accessToken, userId, fileType, fileName, fileSize, hashes) {
    return apiRequest(accessToken, "POST", `/v2/users/${userId}/upload_prepare`, { file_type: fileType, file_name: fileName, file_size: fileSize, md5: hashes.md5, sha1: hashes.sha1, md5_10m: hashes.md5_10m });
}
/**
 * 完成分片上传（C2C）
 * POST /v2/users/{user_id}/upload_part_finish
 *
 * @param accessToken - 访问令牌
 * @param userId - 用户 openid
 * @param uploadId - 上传任务 ID
 * @param partIndex - 分片索引（从 1 开始）
 * @param blockSize - 分块大小（字节）
 * @param md5 - 分片数据的 MD5（十六进制）
 */
export async function c2cUploadPartFinish(accessToken, userId, uploadId, partIndex, blockSize, md5, retryTimeoutMs) {
    await partFinishWithRetry(accessToken, "POST", `/v2/users/${userId}/upload_part_finish`, { upload_id: uploadId, part_index: partIndex, block_size: blockSize, md5 }, retryTimeoutMs);
}
/**
 * 完成文件上传（C2C）
 * POST /v2/users/{user_id}/files
 *
 * @param accessToken - 访问令牌
 * @param userId - 用户 openid
 * @param uploadId - 上传任务 ID
 * @returns 文件信息（file_uuid, file_info, ttl）
 */
export async function c2cCompleteUpload(accessToken, userId, uploadId) {
    return completeUploadWithRetry(accessToken, "POST", `/v2/users/${userId}/files`, { upload_id: uploadId });
}
/**
 * 申请上传（Group）
 * POST /v2/groups/{group_id}/upload_prepare
 */
export async function groupUploadPrepare(accessToken, groupId, fileType, fileName, fileSize, hashes) {
    return apiRequest(accessToken, "POST", `/v2/groups/${groupId}/upload_prepare`, { file_type: fileType, file_name: fileName, file_size: fileSize, md5: hashes.md5, sha1: hashes.sha1, md5_10m: hashes.md5_10m });
}
/**
 * 完成分片上传（Group）
 * POST /v2/groups/{group_id}/upload_part_finish
 */
export async function groupUploadPartFinish(accessToken, groupId, uploadId, partIndex, blockSize, md5, retryTimeoutMs) {
    await partFinishWithRetry(accessToken, "POST", `/v2/groups/${groupId}/upload_part_finish`, { upload_id: uploadId, part_index: partIndex, block_size: blockSize, md5 }, retryTimeoutMs);
}
/**
 * 完成文件上传（Group）
 * POST /v2/groups/{group_id}/files
 */
export async function groupCompleteUpload(accessToken, groupId, uploadId) {
    return completeUploadWithRetry(accessToken, "POST", `/v2/groups/${groupId}/files`, { upload_id: uploadId });
}
export async function uploadC2CMedia(accessToken, openid, fileType, url, fileData, srvSendMsg = false, fileName) {
    if (!url && !fileData)
        throw new Error("uploadC2CMedia: url or fileData is required");
    if (fileData) {
        const contentHash = computeFileHash(fileData);
        const cachedInfo = getCachedFileInfo(contentHash, "c2c", openid, fileType);
        if (cachedInfo) {
            return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
        }
    }
    const body = { file_type: fileType, srv_send_msg: srvSendMsg };
    if (url)
        body.url = url;
    else if (fileData)
        body.file_data = fileData;
    if (fileType === MediaFileType.FILE && fileName)
        body.file_name = sanitizeFileName(fileName);
    const result = await apiRequestWithRetry(accessToken, "POST", `/v2/users/${openid}/files`, body);
    if (fileData && result.file_info && result.ttl > 0) {
        const contentHash = computeFileHash(fileData);
        setCachedFileInfo(contentHash, "c2c", openid, fileType, result.file_info, result.file_uuid, result.ttl);
    }
    return result;
}
export async function uploadGroupMedia(accessToken, groupOpenid, fileType, url, fileData, srvSendMsg = false, fileName) {
    if (!url && !fileData)
        throw new Error("uploadGroupMedia: url or fileData is required");
    if (fileData) {
        const contentHash = computeFileHash(fileData);
        const cachedInfo = getCachedFileInfo(contentHash, "group", groupOpenid, fileType);
        if (cachedInfo) {
            return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
        }
    }
    const body = { file_type: fileType, srv_send_msg: srvSendMsg };
    if (url)
        body.url = url;
    else if (fileData)
        body.file_data = fileData;
    if (fileType === MediaFileType.FILE && fileName)
        body.file_name = sanitizeFileName(fileName);
    const result = await apiRequestWithRetry(accessToken, "POST", `/v2/groups/${groupOpenid}/files`, body);
    if (fileData && result.file_info && result.ttl > 0) {
        const contentHash = computeFileHash(fileData);
        setCachedFileInfo(contentHash, "group", groupOpenid, fileType, result.file_info, result.file_uuid, result.ttl);
    }
    return result;
}
export async function sendC2CMediaMessage(accessToken, openid, fileInfo, msgId, content, meta) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    return sendAndNotify(accessToken, "POST", `/v2/users/${openid}/messages`, {
        msg_type: 7,
        media: { file_info: fileInfo },
        msg_seq: msgSeq,
        ...(content ? { content } : {}),
        ...(msgId ? { msg_id: msgId } : {}),
    }, meta ?? { text: content });
}
export async function sendGroupMediaMessage(accessToken, groupOpenid, fileInfo, msgId, content) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
        msg_type: 7,
        media: { file_info: fileInfo },
        msg_seq: msgSeq,
        ...(content ? { content } : {}),
        ...(msgId ? { msg_id: msgId } : {}),
    });
}
export async function sendC2CImageMessage(accessToken, openid, imageUrl, msgId, content, localPath) {
    let uploadResult;
    const isBase64 = imageUrl.startsWith("data:");
    if (isBase64) {
        const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches)
            throw new Error("Invalid Base64 Data URL format");
        uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, undefined, matches[2], false);
    }
    else {
        uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, imageUrl, undefined, false);
    }
    const meta = {
        text: content,
        mediaType: "image",
        ...(!isBase64 ? { mediaUrl: imageUrl } : {}),
        ...(localPath ? { mediaLocalPath: localPath } : {}),
    };
    return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content, meta);
}
export async function sendGroupImageMessage(accessToken, groupOpenid, imageUrl, msgId, content) {
    let uploadResult;
    const isBase64 = imageUrl.startsWith("data:");
    if (isBase64) {
        const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches)
            throw new Error("Invalid Base64 Data URL format");
        uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, undefined, matches[2], false);
    }
    else {
        uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, imageUrl, undefined, false);
    }
    return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}
export async function sendC2CVoiceMessage(accessToken, openid, voiceBase64, voiceUrl, msgId, ttsText, filePath) {
    const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VOICE, voiceUrl, voiceBase64, false);
    return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, undefined, {
        mediaType: "voice",
        ...(ttsText ? { ttsText } : {}),
        ...(filePath ? { mediaLocalPath: filePath } : {})
    });
}
export async function sendGroupVoiceMessage(accessToken, groupOpenid, voiceBase64, voiceUrl, msgId) {
    const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VOICE, voiceUrl, voiceBase64, false);
    return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}
export async function sendC2CFileMessage(accessToken, openid, fileBase64, fileUrl, msgId, fileName, localFilePath) {
    const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
    return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, undefined, { mediaType: "file", mediaUrl: fileUrl, mediaLocalPath: localFilePath ?? fileName });
}
export async function sendGroupFileMessage(accessToken, groupOpenid, fileBase64, fileUrl, msgId, fileName) {
    const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
    return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}
export async function sendC2CVideoMessage(accessToken, openid, videoUrl, videoBase64, msgId, content, localPath) {
    const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
    return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content, { text: content, mediaType: "video", ...(videoUrl ? { mediaUrl: videoUrl } : {}), ...(localPath ? { mediaLocalPath: localPath } : {}) });
}
export async function sendGroupVideoMessage(accessToken, groupOpenid, videoUrl, videoBase64, msgId, content) {
    const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
    return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}
const backgroundRefreshControllers = new Map();
export function startBackgroundTokenRefresh(appId, clientSecret, options) {
    if (backgroundRefreshControllers.has(appId)) {
        log.info(`[qqbot-api:${appId}] Background token refresh already running`);
        return;
    }
    const { refreshAheadMs = 5 * 60 * 1000, randomOffsetMs = 30 * 1000, minRefreshIntervalMs = 60 * 1000, retryDelayMs = 5 * 1000, log: refreshLog, } = options ?? {};
    const controller = new AbortController();
    backgroundRefreshControllers.set(appId, controller);
    const signal = controller.signal;
    const refreshLoop = async () => {
        refreshLog?.info?.(`[qqbot-api:${appId}] Background token refresh started`);
        while (!signal.aborted) {
            try {
                await getAccessToken(appId, clientSecret);
                const cached = tokenCacheMap.get(appId);
                if (cached) {
                    const expiresIn = cached.expiresAt - Date.now();
                    const randomOffset = Math.random() * randomOffsetMs;
                    const refreshIn = Math.max(expiresIn - refreshAheadMs - randomOffset, minRefreshIntervalMs);
                    refreshLog?.debug?.(`[qqbot-api:${appId}] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`);
                    await sleep(refreshIn, signal);
                }
                else {
                    refreshLog?.debug?.(`[qqbot-api:${appId}] No cached token, retrying soon`);
                    await sleep(minRefreshIntervalMs, signal);
                }
            }
            catch (err) {
                if (signal.aborted)
                    break;
                refreshLog?.error?.(`[qqbot-api:${appId}] Background token refresh failed: ${err}`);
                await sleep(retryDelayMs, signal);
            }
        }
        backgroundRefreshControllers.delete(appId);
        refreshLog?.info?.(`[qqbot-api:${appId}] Background token refresh stopped`);
    };
    refreshLoop().catch((err) => {
        backgroundRefreshControllers.delete(appId);
        refreshLog?.error?.(`[qqbot-api:${appId}] Background token refresh crashed: ${err}`);
    });
}
/**
 * 停止后台 Token 刷新
 * @param appId 选填。如果有，仅停止该账号的定时刷新。
 */
export function stopBackgroundTokenRefresh(appId) {
    if (appId) {
        const controller = backgroundRefreshControllers.get(appId);
        if (controller) {
            controller.abort();
            backgroundRefreshControllers.delete(appId);
        }
    }
    else {
        for (const controller of backgroundRefreshControllers.values()) {
            controller.abort();
        }
        backgroundRefreshControllers.clear();
    }
}
export function isBackgroundTokenRefreshRunning(appId) {
    if (appId)
        return backgroundRefreshControllers.has(appId);
    return backgroundRefreshControllers.size > 0;
}
async function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) {
            if (signal.aborted) {
                clearTimeout(timer);
                reject(new Error("Aborted"));
                return;
            }
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error("Aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}
/**
 * 发送流式消息（C2C 私聊）
 *
 * 流式协议：
 * - 首次调用时不传 stream_msg_id，由平台返回
 * - 后续分片携带 stream_msg_id 和递增 msg_seq
 * - input_state="1" 表示生成中，"10" 表示生成结束（终结状态）
 *
 * 仅在终结分片（input_state=DONE）时触发 refIdx 回调，
 * 中间分片直接调用 apiRequest，避免存入过多无效的中间态数据。
 *
 * @param accessToken - access_token
 * @param openid - 用户 openid
 * @param req - 流式消息请求体
 * @returns 消息响应（复用 MessageResponse，错误会直接抛出异常）
 */
export async function sendC2CStreamMessage(accessToken, openid, req) {
    const path = `/v2/users/${openid}/stream_messages`;
    const body = {
        input_mode: req.input_mode,
        input_state: req.input_state,
        content_type: req.content_type,
        content_raw: req.content_raw,
        event_id: req.event_id,
        msg_id: req.msg_id,
        msg_seq: req.msg_seq,
        index: req.index,
    };
    if (req.stream_msg_id) {
        body.stream_msg_id = req.stream_msg_id;
    }
    return apiRequest(accessToken, "POST", path, body);
}
