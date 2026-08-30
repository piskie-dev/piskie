import { generateReqId } from '@wecom/aibot-node-sdk';
import { REPLY_SEND_TIMEOUT_MS } from './const.js';
import { withTimeout } from './timeout.js';

/**
 * 企业微信消息发送模块
 *
 * 负责通过 WSClient 发送回复消息，包含超时保护
 */
// ============================================================================
// 流式过期错误（errcode 846608）
// ============================================================================
/** 流式回复超时错误码（>6分钟未更新，服务端拒绝继续流式更新） */
const STREAM_EXPIRED_ERRCODE = 846608;
/**
 * 流式回复过期错误
 * 当服务端返回 errcode=846608 时抛出，表示流式消息已超过6分钟无法更新，
 * 调用方需降级为主动发送（sendMessage）方式回复。
 */
class StreamExpiredError extends Error {
    constructor(message) {
        super(message ?? `Stream message update expired (errcode=${STREAM_EXPIRED_ERRCODE})`);
        this.errcode = STREAM_EXPIRED_ERRCODE;
        this.name = "StreamExpiredError";
    }
}
// ============================================================================
// 消息发送
// ============================================================================
/**
 * 发送企业微信回复消息
 * 供 monitor 内部和 channel outbound 使用
 *
 * @returns messageId (streamId)
 */
async function sendWeComReply(params) {
    const { wsClient, frame, text, runtime, finish = true, streamId: existingStreamId } = params;
    if (!text) {
        return "";
    }
    const streamId = existingStreamId || generateReqId("stream");
    if (!wsClient.isConnected) {
        runtime.error?.(`[wecom] WSClient not connected, cannot send reply`);
        throw new Error("WSClient not connected");
    }
    const body = frame.body;
    // 事件回调（aibot_event_callback）没有可用于 replyStream 的有效 req_id，
    // 对该场景改用主动发送 sendMessage，避免 846605 invalid req_id。
    if (body.msgtype === "event") {
        // 中间帧（thinking / 流式增量）直接跳过，仅在最终帧主动发一次文本。
        if (!finish) {
            runtime.log?.(`[plugin -> server] skip non-final stream for event callback, streamId=${streamId}`);
            return streamId;
        }
        const chatId = body.chatid || body.from?.userid;
        if (!chatId) {
            throw new Error("Missing chatId for event callback reply");
        }
        await withTimeout(wsClient.sendMessage(chatId, {
            msgtype: "markdown",
            markdown: { content: text },
        }), REPLY_SEND_TIMEOUT_MS, `Event reply send timed out (streamId=${streamId})`);
        runtime.log?.(`[plugin -> server] event-active-send chatId=${chatId}, finish=${finish}`);
        return streamId;
    }
    // 非事件消息，继续使用 replyStream（被动回复）
    // 使用 SDK 的 replyStream 方法发送消息，带超时保护
    try {
        await withTimeout(wsClient.replyStream(frame, streamId, text, finish), REPLY_SEND_TIMEOUT_MS, `Reply send timed out (streamId=${streamId})`);
    }
    catch (err) {
        // 服务端返回 846608：流式消息超过6分钟无法更新，需降级为主动发送
        const errMsg = err?.errmsg || err?.message || String(err);
        if (err?.errcode === STREAM_EXPIRED_ERRCODE ||
            errMsg.includes(String(STREAM_EXPIRED_ERRCODE))) {
            throw new StreamExpiredError(errMsg);
        }
        throw err;
    }
    runtime.log?.(`[plugin -> server] streamId=${streamId}, finish=${finish}`);
    return streamId;
}

export { STREAM_EXPIRED_ERRCODE, StreamExpiredError, sendWeComReply };
