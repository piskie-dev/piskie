/**
 * 输入状态自动续期
 * 在消息处理期间定时续发 "正在输入" 状态通知，确保用户持续看到 bot 在处理中。
 * 仅 C2C 私聊有效（QQ 群聊 API 不支持输入状态通知）。
 */
import { sendC2CInputNotify } from "./api.js";
// 每 50 秒续发一次（QQ API input_second=60，留 10s 余量）
export const TYPING_INTERVAL_MS = 50_000;
export const TYPING_INPUT_SECOND = 60;
export class TypingKeepAlive {
    getToken;
    clearCache;
    openid;
    msgId;
    log;
    logPrefix;
    timer = null;
    stopped = false;
    constructor(getToken, clearCache, openid, msgId, log, logPrefix = "[qqbot]") {
        this.getToken = getToken;
        this.clearCache = clearCache;
        this.openid = openid;
        this.msgId = msgId;
        this.log = log;
        this.logPrefix = logPrefix;
    }
    /** 启动定时续期（首次发送由调用方自行处理，这里只负责后续续期） */
    start() {
        if (this.stopped)
            return;
        this.timer = setInterval(() => {
            if (this.stopped) {
                this.stop();
                return;
            }
            this.send().catch(() => { });
        }, TYPING_INTERVAL_MS);
    }
    /** 停止续期 */
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async send() {
        try {
            const token = await this.getToken();
            await sendC2CInputNotify(token, this.openid, this.msgId, TYPING_INPUT_SECOND);
            this.log?.debug?.(`${this.logPrefix} Typing keep-alive sent to ${this.openid}`);
        }
        catch (err) {
            try {
                this.clearCache();
                const token = await this.getToken();
                await sendC2CInputNotify(token, this.openid, this.msgId, TYPING_INPUT_SECOND);
            }
            catch {
                this.log?.debug?.(`${this.logPrefix} Typing keep-alive failed for ${this.openid}: ${err}`);
            }
        }
    }
}
