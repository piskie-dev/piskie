/**
 * 群历史消息缓存
 *
 * 非@消息写入内存 Map，被@时一次性注入上下文后清空。
 * 自包含实现，不依赖 openclaw/plugin-sdk。
 */
// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 历史上下文段落标签 */
const HISTORY_CTX_START = "[上次回复后的聊天消息 - 作为上下文]";
const HISTORY_CTX_END = "[当前消息 - 请回复此条]";
/** 合并消息段落标签 */
const MERGED_CTX_START = "[以下是合并消息 - 作为上下文]";
const MERGED_CTX_END = "[当前消息 - 结合上下文回复]";
/** 历史 Map 最大 key 数量（LRU 淘汰，防止无限增长） */
const MAX_HISTORY_KEYS = 1000;
/**
 * 根据 content_type 推断附件类型（统一判断逻辑，避免多处重复）
 */
export function inferAttachmentType(contentType) {
    const ct = (contentType ?? "").toLowerCase();
    if (ct.startsWith("image/"))
        return "image";
    if (ct === "voice" || ct.startsWith("audio/") || ct.includes("silk") || ct.includes("amr"))
        return "voice";
    if (ct.startsWith("video/"))
        return "video";
    if (ct.startsWith("application/") || ct.startsWith("text/"))
        return "file";
    return "unknown";
}
/**
 * 将原始附件数组转换为 AttachmentSummary 数组。
 *
 * 统一"原始附件 → 摘要"的映射逻辑，供历史记录缓存、合并消息格式化等场景复用。
 * 无附件时返回 undefined（而非空数组），与 HistoryEntry.attachments 的可选语义一致。
 */
export function toAttachmentSummaries(attachments) {
    if (!attachments?.length)
        return undefined;
    return attachments.map((att) => ({
        type: inferAttachmentType(att.content_type),
        filename: att.filename,
        transcript: att.asr_refer_text || undefined,
        url: att.url || undefined,
    }));
}
/**
 * 格式化单条消息内容：表情标签解析 → mention 清理 → 附件标签拼接。
 *
 * 用于合并消息的逐条子消息格式化，将外部依赖（parseFaceTags / stripMentionText）
 * 通过参数注入，保持本模块自包含。
 */
export function formatMessageContent(params) {
    let msgContent = params.parseFaceTags(params.content);
    if (params.chatType === "group" && params.mentions?.length && params.stripMentionText) {
        msgContent = params.stripMentionText(msgContent, params.mentions);
    }
    if (params.attachments?.length) {
        const attachmentDesc = formatAttachmentTags(toAttachmentSummaries(params.attachments));
        if (attachmentDesc) {
            msgContent = `${msgContent} ${attachmentDesc}`;
        }
    }
    return msgContent;
}
// ---------------------------------------------------------------------------
// 附件标签格式化（全局统一）
// ---------------------------------------------------------------------------
/**
 * 将附件摘要格式化为统一的人类可读标签描述（供 AI 上下文注入）。
 *
 * PISKIE 本地改动（49号 §4.3.5/§11.7）：正文不得含本地路径、远程 URL 或
 * MEDIA: 占位符——原「有路径附件 → MEDIA:path」风格整体改为纯描述性标签：
 *   语音+转录 → [语音消息（内容: "transcript"）]
 *   其余      → [图片] / [语音消息] / [视频] / [文件]（可带 filename）
 *
 * 此函数是所有附件描述的 **唯一格式化入口**，确保引用消息、群历史缓存、
 * 当前消息动态上下文三处标签风格完全一致。
 */
export function formatAttachmentTags(attachments) {
    if (!attachments?.length)
        return "";
    const parts = [];
    for (const att of attachments) {
        switch (att.type) {
            case "image":
                parts.push(`[图片${att.filename ? `: ${att.filename}` : ""}]`);
                break;
            case "voice":
                parts.push(att.transcript
                    ? `[语音消息（内容: "${att.transcript}"）]`
                    : "[语音消息]");
                break;
            case "video":
                parts.push(`[视频${att.filename ? `: ${att.filename}` : ""}]`);
                break;
            case "file":
                parts.push(`[文件${att.filename ? `: ${att.filename}` : ""}]`);
                break;
            default:
                parts.push(`[附件${att.filename ? `: ${att.filename}` : ""}]`);
        }
    }
    return parts.join("\n");
}
/** @deprecated 使用 formatAttachmentTags 代替 */
export const formatHistoryAttachments = formatAttachmentTags;
// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------
/**
 * LRU 淘汰：当 historyMap 的 key 数量超过阈值时，删除最早插入的 key。
 */
function evictOldHistoryKeys(historyMap, maxKeys = MAX_HISTORY_KEYS) {
    if (historyMap.size <= maxKeys)
        return;
    const keysToDelete = historyMap.size - maxKeys;
    const iterator = historyMap.keys();
    for (let i = 0; i < keysToDelete; i++) {
        const key = iterator.next().value;
        if (key !== undefined) {
            historyMap.delete(key);
        }
    }
}
/**
 * 向指定 key 的历史列表追加一条记录，超出 limit 时从头部淘汰。
 * 同时刷新 key 的插入顺序（Map 迭代顺序 = 插入顺序），实现 LRU 语义。
 */
function appendHistoryEntry(params) {
    const { historyMap, historyKey, entry } = params;
    if (params.limit <= 0)
        return [];
    const history = historyMap.get(historyKey) ?? [];
    history.push(entry);
    while (history.length > params.limit) {
        history.shift();
    }
    // 刷新插入顺序
    if (historyMap.has(historyKey)) {
        historyMap.delete(historyKey);
    }
    historyMap.set(historyKey, history);
    evictOldHistoryKeys(historyMap);
    return history;
}
// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------
/**
 * 记录一条待注入的历史消息（非@消息调用此函数）。
 * limit <= 0 或 entry 为空时不记录。
 */
export function recordPendingHistoryEntry(params) {
    if (!params.entry || params.limit <= 0)
        return [];
    return appendHistoryEntry({
        historyMap: params.historyMap,
        historyKey: params.historyKey,
        entry: params.entry,
        limit: params.limit,
    });
}
/**
 * 构建包含历史上下文的完整消息体（被@时调用）。
 * 如果没有累积的历史消息，直接返回 currentMessage 原文。
 */
export function buildPendingHistoryContext(params) {
    if (params.limit <= 0)
        return params.currentMessage;
    const entries = params.historyMap.get(params.historyKey) ?? [];
    if (entries.length === 0)
        return params.currentMessage;
    const lineBreak = params.lineBreak ?? "\n";
    const historyText = entries.map(params.formatEntry).join(lineBreak);
    return [
        HISTORY_CTX_START,
        historyText,
        "",
        HISTORY_CTX_END,
        params.currentMessage,
    ].join(lineBreak);
}
/**
 * 构建合并消息上下文（多条排队消息被合并时调用）。
 * 前置消息用 [合并消息开始]...[合并消息结束] 段落标签包裹，
 * 最后一条作为当前消息紧跟其后。
 * 如果只有一条消息，直接返回 currentMessage 原文。
 */
export function buildMergedMessageContext(params) {
    const { precedingParts, currentMessage } = params;
    if (precedingParts.length === 0)
        return currentMessage;
    const lineBreak = params.lineBreak ?? "\n";
    return [
        MERGED_CTX_START,
        precedingParts.join(lineBreak),
        MERGED_CTX_END,
        currentMessage,
    ].join(lineBreak);
}
/**
 * 清空指定群的历史缓存（回复完成后调用）。
 * limit <= 0 表示功能已禁用，不做操作。
 */
export function clearPendingHistory(params) {
    if (params.limit <= 0)
        return;
    params.historyMap.set(params.historyKey, []);
}
