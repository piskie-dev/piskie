import { randomUUID } from "node:crypto";
import { apiGetFetch, apiPostFetch } from "../api/api.js";
import { loadWeixinAccount } from "./accounts.js";
import { logger } from "../util/logger.js";
import { redactToken } from "../util/redact.js";

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_REQUEST_TIMEOUT_MS = 15_000;
const VERIFY_CODE_MAX_LENGTH = 8;
export const DEFAULT_ILINK_BOT_TYPE = "3";
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const activeLogins = new Map();
const pendingStarts = new Map();

function isLoginFresh(login) {
    return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function abortActiveWait(login) {
    login.waitAbortController?.abort();
    login.waitAbortController = undefined;
    login.waiting = false;
}

function removeLogin(sessionKey, expected) {
    const current = activeLogins.get(sessionKey);
    if (!current || (expected && current !== expected))
        return false;
    abortActiveWait(current);
    activeLogins.delete(sessionKey);
    return true;
}

function purgeExpiredLogins() {
    for (const [sessionKey, login] of activeLogins) {
        if (!isLoginFresh(login))
            removeLogin(sessionKey, login);
    }
}

function getLocalBotTokenList(localAccountId) {
    if (!localAccountId)
        return [];
    const token = loadWeixinAccount(localAccountId)?.token?.trim();
    return token ? [token] : [];
}

async function fetchQRCode(botType, localAccountId, abortSignal) {
    const localTokenList = getLocalBotTokenList(localAccountId);
    logger.info(`fetchQRCode: bot_type=${botType} local_token_list count=${localTokenList.length}`);
    const rawText = await apiPostFetch({
        baseUrl: FIXED_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: JSON.stringify({ local_token_list: localTokenList }),
        timeoutMs: QR_REQUEST_TIMEOUT_MS,
        abortSignal,
        label: "fetchQRCode",
    });
    return JSON.parse(rawText);
}

async function pollQRStatus(apiBaseUrl, qrcode, verifyCode, abortSignal) {
    logger.debug(`Long-poll QR status from: ${apiBaseUrl} qrcode=***`);
    try {
        let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
        if (verifyCode)
            endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
        const rawText = await apiGetFetch({
            baseUrl: apiBaseUrl,
            endpoint,
            timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
            abortSignal,
            label: "pollQRStatus",
        });
        logger.debug(`pollQRStatus: body=${rawText.substring(0, 200)}`);
        return JSON.parse(rawText);
    }
    catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            if (abortSignal?.aborted)
                throw err;
            logger.debug(`pollQRStatus: client-side timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`);
            return { status: "wait" };
        }
        logger.warn(`pollQRStatus: network/gateway error, will retry: ${String(err)}`);
        return { status: "wait" };
    }
}

function waitDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/** CLI-only initial QR rendering. GUI callers consume qrcodeUrl directly. */
export async function displayQRCode(qrcodeUrl) {
    try {
        const qrterm = await import("qrcode-terminal");
        qrterm.default.generate(qrcodeUrl, { small: true });
    }
    catch {
        // URL fallback below remains usable when qrcode-terminal is unavailable.
    }
    process.stdout.write(`若二维码未能显示或无法使用，你可以访问以下链接以继续：\n${qrcodeUrl}\n`);
}

export async function startWeixinLoginWithQr(opts) {
    const sessionKey = opts.accountId || randomUUID();
    purgeExpiredLogins();
    const existing = activeLogins.get(sessionKey);
    if (!opts.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
        return {
            qrcodeUrl: existing.qrcodeUrl,
            message: "二维码已显示，请用手机微信扫描。",
            sessionKey,
        };
    }
    if (!opts.force && pendingStarts.has(sessionKey)) {
        return { message: "二维码正在生成，请稍后重试。", sessionKey };
    }
    if (existing)
        removeLogin(sessionKey, existing);
    pendingStarts.get(sessionKey)?.abort();
    const startController = new AbortController();
    pendingStarts.set(sessionKey, startController);
    try {
        const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
        const qrResponse = await fetchQRCode(botType, opts.localAccountId, startController.signal);
        if (startController.signal.aborted || pendingStarts.get(sessionKey) !== startController) {
            return { message: "登录已取消。", sessionKey };
        }
        if (!qrResponse.qrcode || !qrResponse.qrcode_img_content)
            throw new Error("服务器未返回有效二维码");
        logger.info(`QR code received, qrcode=${redactToken(qrResponse.qrcode)} imgContentLen=${qrResponse.qrcode_img_content.length}`);
        activeLogins.set(sessionKey, {
            sessionKey,
            qrcode: qrResponse.qrcode,
            qrcodeUrl: qrResponse.qrcode_img_content,
            localAccountId: opts.localAccountId,
            startedAt: Date.now(),
            currentApiBaseUrl: FIXED_BASE_URL,
            waiting: false,
        });
        return {
            qrcodeUrl: qrResponse.qrcode_img_content,
            message: "用手机微信扫描以下二维码，以继续连接：",
            sessionKey,
        };
    }
    catch (err) {
        if (startController.signal.aborted)
            return { message: "登录已取消。", sessionKey };
        logger.error(`Failed to start Weixin login: ${String(err)}`);
        return { message: `Failed to start login: ${String(err)}`, sessionKey };
    }
    finally {
        if (pendingStarts.get(sessionKey) === startController)
            pendingStarts.delete(sessionKey);
    }
}

export function submitWeixinLoginVerifyCode(sessionKey, rawCode) {
    purgeExpiredLogins();
    const activeLogin = activeLogins.get(sessionKey);
    if (!activeLogin || !isLoginFresh(activeLogin)) {
        return { accepted: false, message: "当前没有进行中的登录，请重新生成二维码。" };
    }
    if (activeLogin.waiting) {
        return { accepted: false, message: "登录状态仍在查询中，请稍后再试。" };
    }
    const code = String(rawCode ?? "").trim();
    if (!/^\d+$/.test(code) || code.length > VERIFY_CODE_MAX_LENGTH) {
        return { accepted: false, message: `请输入不超过 ${VERIFY_CODE_MAX_LENGTH} 位的数字验证码。` };
    }
    activeLogin.pendingVerifyCode = code;
    return { accepted: true, message: "验证码已提交，正在继续验证。" };
}

export function cancelWeixinLogin(sessionKey) {
    const pending = pendingStarts.get(sessionKey);
    if (pending) {
        pendingStarts.delete(sessionKey);
        pending.abort();
    }
    const removed = removeLogin(sessionKey);
    return { cancelled: Boolean(pending) || removed, message: "登录已取消。" };
}

export async function waitForWeixinLogin(opts) {
    purgeExpiredLogins();
    const activeLogin = activeLogins.get(opts.sessionKey);
    if (!activeLogin || !isLoginFresh(activeLogin)) {
        return { connected: false, state: "expired", message: "二维码已过期，请重新生成。" };
    }
    if (activeLogin.waiting) {
        return { connected: false, state: "error", message: "登录状态查询正在进行，请勿重复提交。" };
    }

    const controller = new AbortController();
    activeLogin.waiting = true;
    activeLogin.waitAbortController = controller;
    const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
    const deadline = Date.now() + timeoutMs;
    logger.info(`Starting to poll QR code status sessionKey=${opts.sessionKey}`);

    try {
        while (Date.now() < deadline) {
            if (activeLogins.get(opts.sessionKey) !== activeLogin || controller.signal.aborted) {
                return { connected: false, state: "error", message: "登录已取消。" };
            }
            const statusResponse = await pollQRStatus(
                activeLogin.currentApiBaseUrl ?? FIXED_BASE_URL,
                activeLogin.qrcode,
                activeLogin.pendingVerifyCode,
                controller.signal,
            );
            activeLogin.status = statusResponse.status;
            switch (statusResponse.status) {
                case "wait":
                    break;
                case "scaned":
                    activeLogin.pendingVerifyCode = undefined;
                    break;
                case "need_verifycode": {
                    const wasRetry = Boolean(activeLogin.pendingVerifyCode);
                    activeLogin.pendingVerifyCode = undefined;
                    return {
                        connected: false,
                        state: "need_verify_code",
                        message: wasRetry
                            ? "你输入的数字不匹配，请重新输入。"
                            : "请输入手机微信显示的数字，以继续连接。",
                    };
                }
                case "expired":
                    activeLogins.delete(opts.sessionKey);
                    return { connected: false, state: "expired", message: "二维码已过期，请重新生成。" };
                case "verify_code_blocked":
                    activeLogins.delete(opts.sessionKey);
                    return {
                        connected: false,
                        state: "verify_code_blocked",
                        message: "多次输入错误，连接流程已停止。请重新生成二维码。",
                    };
                case "binded_redirect": {
                    const localAccount = activeLogin.localAccountId
                        ? loadWeixinAccount(activeLogin.localAccountId)
                        : null;
                    activeLogins.delete(opts.sessionKey);
                    if (!activeLogin.localAccountId || !localAccount?.token?.trim()) {
                        return {
                            connected: false,
                            state: "error",
                            message: "微信返回已连接状态，但无法确定对应的本地账号。",
                        };
                    }
                    return {
                        connected: false,
                        state: "already_connected",
                        alreadyConnected: true,
                        accountId: activeLogin.localAccountId,
                        message: "该账号已经连接，无需重复连接。",
                    };
                }
                case "scaned_but_redirect":
                    if (statusResponse.redirect_host) {
                        activeLogin.currentApiBaseUrl = `https://${statusResponse.redirect_host}`;
                    }
                    break;
                case "confirmed":
                    activeLogins.delete(opts.sessionKey);
                    if (!statusResponse.ilink_bot_id || !statusResponse.bot_token) {
                        return {
                            connected: false,
                            state: "error",
                            message: "登录失败：服务器未返回完整账号凭证。",
                        };
                    }
                    return {
                        connected: true,
                        state: "connected",
                        botToken: statusResponse.bot_token,
                        accountId: statusResponse.ilink_bot_id,
                        baseUrl: statusResponse.baseurl,
                        userId: statusResponse.ilink_user_id,
                        message: "已将此 OpenClaw 连接到微信。",
                    };
                default:
                    logger.warn(`waitForWeixinLogin: unknown status=${String(statusResponse.status)}`);
                    break;
            }
            await waitDelay(1000, controller.signal);
        }
        activeLogins.delete(opts.sessionKey);
        return { connected: false, state: "error", message: "登录超时，请重试。" };
    }
    catch (err) {
        if (controller.signal.aborted) {
            return { connected: false, state: "error", message: "登录已取消。" };
        }
        activeLogins.delete(opts.sessionKey);
        logger.error(`Error polling QR status: ${String(err)}`);
        return { connected: false, state: "error", message: `Login failed: ${String(err)}` };
    }
    finally {
        if (activeLogin.waitAbortController === controller)
            activeLogin.waitAbortController = undefined;
        activeLogin.waiting = false;
    }
}
