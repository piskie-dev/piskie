import * as os from 'os';
import * as path from 'path';
import { WSClient, WSAuthFailureError, WSReconnectExhaustedError, generateReqId } from '@wecom/aibot-node-sdk';
import { getDefaultMediaLocalRoots } from './media-compat.js';
import { SCENE_WECOM_OPENCLAW, WS_MAX_AUTH_FAILURE_ATTEMPTS, WS_MAX_RECONNECT_ATTEMPTS, WS_HEARTBEAT_INTERVAL_MS, EVENT_ENTER_CHECK_UPDATE, CMD_ENTER_EVENT_REPLY, CHANNEL_ID, THINKING_MESSAGE } from './const.js';
export { WeComCommand } from './const.js';
import { parseMessageContent } from './message-parser.js';
import { sendWeComReply, StreamExpiredError } from './message-sender.js';
import { downloadAndSaveImages, downloadAndSaveFiles } from './media-handler.js';
import { uploadAndSendMedia } from './media-uploader.js';
import { maskTemplateCardBlocks, extractTemplateCards } from './template-card-parser.js';
import { checkGroupPolicy } from './group-policy.js';
import { checkDmPolicy } from './dm-policy.js';
import { startMessageStateCleanup, setWeComWebSocket, warmupReqIdStore, stopMessageStateCleanup, cleanupAccount, setReqIdForChat, setMessageState, deleteMessageState } from './state-manager.js';
export { getWeComWebSocket } from './state-manager.js';
import { PLUGIN_VERSION } from './version.js';

/**
 * 企业微信 WebSocket 监控器主模块
 *
 * 负责：
 * - 建立和管理 WebSocket 连接
 * - 协调消息处理流程（解析→策略检查→下载图片→路由回复）
 * - 资源生命周期管理
 *
 * 子模块：
 * - message-parser.ts  : 消息内容解析
 * - message-sender.ts  : 消息发送（带超时保护）
 * - media-handler.ts   : 图片下载和保存（带超时保护）
 * - group-policy.ts    : 群组访问控制
 * - dm-policy.ts       : 私聊访问控制
 * - state-manager.ts   : 全局状态管理（带 TTL 清理）
 * - timeout.ts         : 超时工具
 */
/**
 * 去除文本中的 `<think>...</think>` 标签（支持跨行），返回剩余可见文本。
 * 用于判断大模型回复中是否包含实际用户可见内容（而非仅有 thinking 推理过程）。
 */
function stripThinkTags(text) {
    return text;
    // return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
const sentTemplateCardByTaskId = new Map();
const TEMPLATE_CARD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TEMPLATE_CARD_CACHE_MAX_SIZE = 300;
function getTemplateCardCacheKey(accountId, taskId) {
    return `${accountId}:${taskId}`;
}
function pruneTemplateCardCache() {
    const now = Date.now();
    for (const [key, entry] of sentTemplateCardByTaskId) {
        if (now - entry.createdAt >= TEMPLATE_CARD_CACHE_TTL_MS) {
            sentTemplateCardByTaskId.delete(key);
        }
    }
    if (sentTemplateCardByTaskId.size <= TEMPLATE_CARD_CACHE_MAX_SIZE) {
        return;
    }
    const sortedEntries = [...sentTemplateCardByTaskId.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const removeCount = sentTemplateCardByTaskId.size - TEMPLATE_CARD_CACHE_MAX_SIZE;
    for (const [key] of sortedEntries.slice(0, removeCount)) {
        sentTemplateCardByTaskId.delete(key);
    }
}
function cloneTemplateCard(card) {
    return JSON.parse(JSON.stringify(card));
}
function saveTemplateCardToCache(params) {
    const { accountId, templateCard, runtime } = params;
    const taskId = templateCard.task_id;
    if (!taskId) {
        runtime.log?.("[wecom][template-card] Skip cache: template card has no task_id");
        return;
    }
    sentTemplateCardByTaskId.set(getTemplateCardCacheKey(accountId, taskId), {
        templateCard: cloneTemplateCard(templateCard),
        createdAt: Date.now(),
    });
    pruneTemplateCardCache();
}
function getTemplateCardFromCache(accountId, taskId) {
    pruneTemplateCardCache();
    const cached = sentTemplateCardByTaskId.get(getTemplateCardCacheKey(accountId, taskId));
    if (!cached) {
        return undefined;
    }
    return cloneTemplateCard(cached.templateCard);
}
function buildSelectedOptionMap(templateCardEvent) {
    const selectedMap = new Map();
    const selectedItems = templateCardEvent?.selected_items?.selected_item ?? [];
    for (const item of selectedItems) {
        const questionKey = item.question_key?.trim();
        if (!questionKey) {
            continue;
        }
        const optionIds = item.option_ids?.option_id?.filter(Boolean) ?? [];
        selectedMap.set(questionKey, optionIds);
    }
    return selectedMap;
}
function applySelectedStateToTemplateCard(params) {
    const { templateCard, selectedMap, templateCardEvent } = params;
    const nextCard = cloneTemplateCard(templateCard);
    if (templateCardEvent?.task_id) {
        nextCard.task_id = templateCardEvent.task_id;
    }
    if (templateCardEvent?.card_type) {
        nextCard.card_type = templateCardEvent.card_type;
    }
    // 交互完成后将提交按钮文案更新为已提交，提升用户感知
    if (nextCard.submit_button?.text) {
        nextCard.submit_button.text = "已提交";
    }
    if (nextCard.checkbox?.question_key) {
        const selectedIds = selectedMap.get(nextCard.checkbox.question_key) ?? [];
        nextCard.checkbox.disable = true;
        if (Array.isArray(nextCard.checkbox.option_list)) {
            nextCard.checkbox.option_list = nextCard.checkbox.option_list.map((option) => ({
                ...option,
                is_checked: selectedIds.includes(option.id),
            }));
        }
    }
    if (Array.isArray(nextCard.select_list)) {
        nextCard.select_list = nextCard.select_list.map((selection) => {
            const selectedIds = selectedMap.get(selection.question_key) ?? [];
            return {
                ...selection,
                disable: true,
                selected_id: selectedIds[0] ?? selection.selected_id,
            };
        });
    }
    if (nextCard.button_selection?.question_key) {
        const selectedIds = selectedMap.get(nextCard.button_selection.question_key) ?? [];
        nextCard.button_selection.disable = true;
        if (selectedIds[0]) {
            nextCard.button_selection.selected_id = selectedIds[0];
        }
    }
    return nextCard;
}
async function updateTemplateCardOnEvent(params) {
    const { frame, accountId, runtime, wsClient } = params;
    const body = frame.body;
    const templateCardEvent = body.event?.template_card_event;
    const taskId = templateCardEvent?.task_id;
    if (!taskId) {
        runtime.log?.(`[${accountId}] [template-card-update] Skip update: missing task_id in callback`);
        return;
    }
    const cachedCard = getTemplateCardFromCache(accountId, taskId);
    if (!cachedCard) {
        runtime.log?.(`[${accountId}] [template-card-update] Skip update: task_id=${taskId} not found in cache`);
        return;
    }
    const selectedMap = buildSelectedOptionMap(templateCardEvent);
    const updatedCard = applySelectedStateToTemplateCard({
        templateCard: cachedCard,
        selectedMap,
        templateCardEvent,
    });
    await wsClient.updateTemplateCard(frame, updatedCard, [body.from.userid]);
    runtime.log?.(`[${accountId}] [template-card-update] Updated card by task_id=${taskId}`);
    // 将更新后的卡片写回缓存，后续多次点击时状态保持一致
    saveTemplateCardToCache({
        accountId,
        templateCard: updatedCard,
        runtime,
    });
}
// ============================================================================
// 媒体本地路径白名单扩展
// ============================================================================
/**
 * 解析 openclaw 状态目录（与 plugin-sdk 内部逻辑保持一致）
 */
function resolveStateDir() {
    const stateOverride = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
    if (stateOverride)
        return stateOverride;
    return path.join(os.homedir(), ".openclaw");
}
/**
 * 在 getDefaultMediaLocalRoots() 基础上，将 stateDir 本身也加入白名单，
 * 并合并用户在 WeComConfig 中配置的自定义 mediaLocalRoots。
 *
 * getDefaultMediaLocalRoots() 仅包含 stateDir 下的子目录（media/agents/workspace/sandboxes），
 * 但 agent 生成的文件可能直接放在 stateDir 根目录下（如 ~/.openclaw-dev/1.png），
 * 因此需要将 stateDir 本身也加入白名单以避免 LocalMediaAccessError。
 *
 * 用户可在 openclaw.json 中配置：
 * {
 *   "channels": {
 *     "wecom": {
 *       "mediaLocalRoots": ["~/Downloads", "~/Documents"]
 *     }
 *   }
 * }
 */
async function getExtendedMediaLocalRoots(config) {
    // 从兼容层获取默认白名单（内部已处理低版本 SDK 的 fallback）
    const defaults = await getDefaultMediaLocalRoots();
    const roots = [...defaults];
    const stateDir = path.resolve(resolveStateDir());
    if (!roots.includes(stateDir)) {
        roots.push(stateDir);
    }
    // 合并用户在 WeComConfig 中配置的自定义路径
    if (config?.mediaLocalRoots) {
        for (const r of config.mediaLocalRoots) {
            const resolved = path.resolve(r.replace(/^~(?=\/|$)/, os.homedir()));
            if (!roots.includes(resolved)) {
                roots.push(resolved);
            }
        }
    }
    return roots;
}
// ============================================================================
// 媒体发送错误提示
// ============================================================================
/**
 * 根据媒体发送结果生成纯文本错误摘要（用于替换 thinking 流式消息展示给用户）。
 *
 * 使用纯文本而非 markdown 格式，因为 replyStream 只支持纯文本。
 */
function buildMediaErrorSummary(mediaUrl, result) {
    if (result.error?.includes("LocalMediaAccessError")) {
        return `⚠️ 文件发送失败：没有权限访问路径 ${mediaUrl}\n请在 openclaw.json 的 mediaLocalRoots 中添加该路径的父目录后重启生效。`;
    }
    if (result.rejectReason) {
        return `⚠️ 文件发送失败：${result.rejectReason}`;
    }
    return `⚠️ 文件发送失败：无法处理文件 ${mediaUrl}，请稍后再试。`;
}
// ============================================================================
// 进站消息构建
// ============================================================================
/**
 * 构建框架 InboundMessage
 * PISKIE 收编改动：原 buildMessageContext 组装 openclaw InboundContext（20+ 字段）
 * 并调用 resolveAgentRoute/finalizeInboundContext；路由与归一化已移入框架
 * InboundPipeline，此处只保留渠道语义（媒体占位符、引用内容）。
 */
function buildInboundMessage(frame, text, mediaList, quoteContent) {
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    const chatType = body.chattype === "group" ? "group" : "direct";
    // PISKIE 收编改动（49号 §4.3）：正文不再拼媒体占位符（纯图片空正文是合法输入，
    // 由核心 magic 检测决定可否注入）；媒体逐文件移交为 InboundMediaFile[]
    const media = mediaList.length > 0
        ? mediaList.map((m) => ({ path: m.path, declaredMediaType: m.contentType || undefined }))
        : undefined;
    return {
        peer: { kind: chatType, id: chatId },
        senderId: body.from.userid,
        text: text || "",
        messageId: body.msgid,
        quotedText: quoteContent,
        media,
    };
}
/**
 * 发送"思考中"消息
 */
async function sendThinkingReply(params) {
    const { wsClient, frame, streamId, runtime, state } = params;
    try {
        await sendWeComReply({
            wsClient,
            frame,
            text: THINKING_MESSAGE,
            runtime,
            finish: false,
            streamId,
        });
    }
    catch (err) {
        if (err instanceof StreamExpiredError && state) {
            state.streamExpired = true;
            runtime.log?.(`[wecom] Stream expired during thinking reply, will fallback to proactive send`);
        }
        else {
            runtime.error?.(`[wecom] Failed to send thinking message: ${String(err)}`);
        }
    }
}
/**
 * 上传并发送一批媒体文件（统一走主动发送通道）
 *
 * replyMedia（被动回复）无法覆盖 replyStream 发出的 thinking 流式消息，
 * 因此所有媒体统一走 aibot_send_msg 主动发送。
 */
async function sendMediaBatch(ctx, mediaUrls) {
    const { wsClient, frame, state, account, runtime } = ctx;
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    const mediaLocalRoots = await getExtendedMediaLocalRoots(account.config);
    runtime.log?.(`[wecom][debug] mediaLocalRoots=${JSON.stringify(mediaLocalRoots)}, mediaUrls=${JSON.stringify(mediaUrls)}`);
    for (const mediaUrl of mediaUrls) {
        const result = await uploadAndSendMedia({
            wsClient,
            mediaUrl,
            chatId,
            mediaLocalRoots,
            log: (...args) => runtime.log?.(...args),
            errorLog: (...args) => runtime.error?.(...args),
        });
        if (result.ok) {
            state.hasMedia = true;
        }
        else {
            state.hasMediaFailed = true;
            runtime.error?.(`[wecom] Media send failed: url=${mediaUrl}, reason=${result.rejectReason || result.error}`);
            // 收集错误摘要，后续在 finishThinkingStream 中直接替换 thinking 流展示给用户
            const summary = buildMediaErrorSummary(mediaUrl, result);
            state.mediaErrorSummary = state.mediaErrorSummary
                ? `${state.mediaErrorSummary}\n\n${summary}`
                : summary;
        }
    }
}
/**
 * 关闭 thinking 流（发送 finish=true 的流式消息）
 *
 * thinking 是通过 replyStream 用 streamId 发的流式消息，
 * 只有同一 streamId 的 replyStream(finish=true) 才能关闭它。
 *
 * ⚠️ 注意：企微会忽略空格等不可见内容，必须用有可见字符的文案才能真正
 *    替换掉 thinking 动画，否则 thinking 会一直残留。
 *
 * 关闭策略（按优先级）：
 * 0. [新增] 有模板卡片代码块 → 提取卡片并主动发送，用剩余文本关闭流
 * 1. 有可见文本 → 用完整文本关闭
 * 2. 有媒体成功发送（通过 deliver 回调） → 用友好提示"文件已发送"
 * 3. 媒体发送失败 → 直接用错误摘要替换 thinking
 * 4. 其他 → 用通用"处理完成"提示
 *    （agent 可能已通过内置 message 工具直接发送了文件，
 *    该路径走 outbound.sendMedia 完全绕过 deliver 回调，
 *    所以 state 中无记录，但文件已实际送达）
 *
 * 降级策略：
 * - 当 streamExpired=true（errcode 846608）时，流式通道已不可用（>6分钟），
 *   改用 wsClient.sendMessage 主动发送完整文本。
 */
async function finishThinkingStream(ctx) {
    const { wsClient, frame, state, runtime } = ctx;
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    const visibleText = stripThinkTags(state.accumulatedText);
    // ── 模板卡片检测与发送 ──────────────────────────────────────────────
    // 在确定 finishText 之前，先检查累积文本中是否包含模板卡片 JSON 代码块。
    // 若检测到合法卡片，通过 sendMessage 主动发送后，用剩余文本关闭流。
    if (visibleText) {
        runtime.log?.(`[wecom][template-card] finishThinkingStream: visibleText exists, length=${visibleText.length}, running extractTemplateCards...`);
        const logFn = (...args) => {
            runtime.log?.(...args);
        };
        const { cards, remainingText } = extractTemplateCards(state.accumulatedText, logFn);
        runtime.log?.(`[wecom][template-card] finishThinkingStream: extractTemplateCards result — cards=${cards.length}, remainingTextLength=${remainingText.length}`);
        if (cards.length > 0) {
            runtime.log?.(`[wecom][template-card] finishThinkingStream: ${cards.length} card(s) detected, card_types=[${cards.map(c => c.cardType).join(", ")}]`);
            await sendTemplateCards(ctx, cards);
            // 用剩余文本关闭流（可能为空）
            const trimmedRemaining = stripThinkTags(remainingText);
            const finishText = trimmedRemaining
                ? remainingText
                : (state.hasTemplateCard ? "📋 卡片消息已发送。" : "");
            runtime.log?.(`[wecom][template-card] finishThinkingStream: closing stream with finishText="${finishText.slice(0, 100)}...", hasTemplateCard=${state.hasTemplateCard}`);
            await sendWeComReply({ wsClient, frame, text: finishText, runtime, finish: true, streamId: state.streamId });
            return;
        }
    }
    else {
        runtime.log?.(`[wecom][template-card] finishThinkingStream: no visibleText, skipping template card extraction`);
    }
    // ── 模板卡片检测结束 ────────────────────────────────────────────────
    let finishText = state.accumulatedText;
    if (visibleText) {
        // 有可见文本：用完整文本关闭流（覆盖 thinking 为真实内容）
        finishText = state.accumulatedText;
    }
    else if (state.hasMedia) {
        if (state.hasMediaFailed && state.mediaErrorSummary) {
            // 媒体成功发送：用友好提示告知用户
            finishText = finishText ? `${finishText}\n\n${state.mediaErrorSummary}` : state.mediaErrorSummary;
        }
        else if (!finishText) {
            finishText = "📎 文件已发送，请查收。";
        }
    }
    // if (!finishText) {
    //   finishText = "✅ 处理完成。";
    // }
    if (finishText) {
        // 尝试流式发送；若已知过期或发送时发现过期，统一降级为主动发送
        let expired = state.streamExpired;
        if (!expired) {
            try {
                await sendWeComReply({ wsClient, frame, text: finishText, runtime, finish: true, streamId: state.streamId });
            }
            catch (err) {
                if (err instanceof StreamExpiredError) {
                    expired = true;
                }
                else {
                    throw err;
                }
            }
        }
        if (expired) {
            runtime.log?.(`[wecom] Stream expired, sending final text via sendMessage (proactive)`);
            await wsClient.sendMessage(chatId, {
                msgtype: "markdown",
                markdown: { content: finishText },
            });
        }
    }
}
/**
 * 逐个发送已提取的模板卡片（通过 wsClient.sendMessage 主动推送）
 *
 * 发送失败不阻塞流程，仅记录错误日志。
 */
async function sendTemplateCards(ctx, cards) {
    const { wsClient, frame, state, runtime, account } = ctx;
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    for (const card of cards) {
        try {
            runtime.log?.(`[wecom][template-card] Sending card_type=${card.cardType} to chatId=${chatId}`);
            const rawTemplateCard = card.cardJson;
            if (typeof rawTemplateCard.card_type !== "string") {
                runtime.error?.("[wecom][template-card] Skip sending invalid card: missing card_type");
                continue;
            }
            const templateCard = rawTemplateCard;
            await wsClient.sendMessage(chatId, {
                msgtype: "template_card",
                template_card: templateCard,
            });
            state.hasTemplateCard = true;
            saveTemplateCardToCache({
                accountId: account.accountId,
                templateCard,
                runtime,
            });
            runtime.log?.(`[wecom][template-card] Card sent successfully: card_type=${card.cardType}`);
        }
        catch (err) {
            runtime.error?.(`[wecom][template-card] Failed to send card: card_type=${card.cardType}, error=${JSON.stringify(err)}`);
        }
    }
}
/**
 * 路由消息到核心处理流程并处理回复
 * PISKIE 收编改动：原经 core.channel.reply.dispatchReplyWithBufferedBlockDispatcher
 * （openclaw dispatcher 协议）分发，现直接调用框架 dispatch(msg, callbacks)；
 * onReplyStart/deliver/onError 三个回调语义与原 dispatcherOptions 完全一致。
 */
async function routeAndDispatchMessage(params) {
    const { inboundMsg, account, wsClient, frame, state, runtime, dispatch, onCleanup } = params;
    const ctx = { wsClient, frame, state, account, runtime };
    // 防止 onCleanup 被多次调用（onError 回调与 catch 块可能重复触发）
    let cleanedUp = false;
    const safeCleanup = () => {
        if (!cleanedUp) {
            cleanedUp = true;
            onCleanup();
        }
    };
    let isShowThink = !(account.sendThinkingMessage ?? true);
    try {
        await dispatch(inboundMsg, {
                onReplyStart: async () => {
                    if (!isShowThink && state.streamId && !state.accumulatedText) {
                        try {
                            await sendThinkingReply({ wsClient, frame, streamId: state.streamId, runtime, state });
                        }
                        catch (e) {
                            runtime.error?.(`[wecom] sendThinkingReply threw err: ${String(e)}`);
                        }
                        isShowThink = true;
                    }
                },
                deliver: async (payload, info) => {
                    state.deliverCalled = true;
                    // runtime.log?.(`[openclaw -> plugin] kind=${info.kind}, text=${payload.text ?? ''}, mediaUrl=${payload.mediaUrl ?? ''}, mediaUrls=${JSON.stringify(payload.mediaUrls ?? [])}`);
                    // 累积文本
                    if (payload.text) {
                        state.accumulatedText += (payload.text || '');
                    }
                    // 发送媒体（统一走主动发送）
                    const mediaUrls = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
                    if (mediaUrls.length > 0) {
                        try {
                            await sendMediaBatch(ctx, mediaUrls);
                        }
                        catch (mediaErr) {
                            // sendMediaBatch 内部异常（如 getDefaultMediaLocalRoots 不可用等）
                            // 必须标记 state，否则 finishThinkingStream 会显示"处理完成"误导用户
                            state.hasMediaFailed = true;
                            const errMsg = String(mediaErr);
                            const summary = `⚠️ 文件发送失败：内部处理异常，请升级 openclaw 到最新版本后重试。\n错误详情：${errMsg}`;
                            state.mediaErrorSummary = state.mediaErrorSummary
                                ? `${state.mediaErrorSummary}\n\n${summary}`
                                : summary;
                            runtime.error?.(`[wecom] sendMediaBatch threw: ${errMsg}`);
                        }
                    }
                    // 中间帧：有可见文本时流式更新（流式过期后跳过，等 deliver 完成后主动发送）
                    // 使用 maskTemplateCardBlocks 遮罩正在构建中的模板卡片代码块，
                    // 避免 JSON 源码在流式输出过程中暴露给终端用户
                    if (info.kind !== "final" && state.accumulatedText && !state.streamExpired) {
                        try {
                            const displayText = maskTemplateCardBlocks(state.accumulatedText, (...args) => runtime.log?.(...args));
                            if (displayText !== state.accumulatedText) {
                                runtime.log?.(`[wecom][template-card] Mid-frame masked: original=${state.accumulatedText.length}chars, masked=${displayText.length}chars`);
                            }
                            await sendWeComReply({ wsClient, frame, text: displayText, runtime, finish: false, streamId: state.streamId });
                        }
                        catch (err) {
                            if (err instanceof StreamExpiredError) {
                                state.streamExpired = true;
                                runtime.log?.(`[wecom] Stream expired during intermediate reply, will fallback to proactive send`);
                            }
                            else {
                                throw err;
                            }
                        }
                    }
                },
                onError: (err, info) => {
                    runtime.error?.(`[wecom] ${info.kind} reply failed: ${String(err)}`);
                },
        });
        // 关闭 thinking 流
        await finishThinkingStream(ctx);
        safeCleanup();
    }
    catch (err) {
        runtime.error?.(`[wecom][plugin] Failed to process message: ${String(err)}`);
        // 即使 dispatch 抛异常，也需要关闭 thinking 流，
        // 避免 deliver 已成功发送媒体但后续出错时 thinking 消息残留或被错误文案覆盖
        try {
            await finishThinkingStream(ctx);
        }
        catch (finishErr) {
            runtime.error?.(`[wecom] Failed to finish thinking stream after dispatch error: ${String(finishErr)}`);
        }
        safeCleanup();
    }
}
/**
 * 处理企业微信消息（主函数）
 *
 * 处理流程：
 * 1. 解析消息内容（文本、图片、引用）
 * 2. 群组策略检查（仅群聊）
 * 3. DM Policy 访问控制检查（仅私聊）
 * 4. 下载并保存图片
 * 5. 初始化消息状态
 * 6. 发送"思考中"消息
 * 7. 路由消息到核心处理流程
 *
 * 整体带超时保护，防止单条消息处理阻塞过久
 */
async function processWeComMessage(params) {
    // PISKIE 收编改动：config（OpenClawConfig）移除，媒体/配对/分发能力（media/pairing/dispatch）
    // 由框架 ConnectorContext 提供并经参数下传
    const { frame, account, runtime, wsClient, media, pairing, dispatch } = params;
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    const chatType = body.chattype === "group" ? "group" : "direct";
    const messageId = body.msgid;
    const reqId = frame.headers.req_id;
    // Step 1: 解析消息内容
    const { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent } = parseMessageContent(body);
    let text = textParts.join("\n").trim();
    // // 群聊中移除 @机器人 的提及标记
    // if (body.chattype === "group") {
    //   text = text.replace(/@\S+/g, "").trim();
    // }
    // 如果文本为空但存在引用消息，使用引用消息内容
    if (!text && quoteContent) {
        text = quoteContent;
        runtime.log?.("[wecom][plugin] Using quote content as message body (user only mentioned bot)");
    }
    // 如果既没有文本也没有图片也没有文件也没有引用内容，则跳过
    if (!text && imageUrls.length === 0 && fileUrls.length === 0) {
        runtime.log?.("[wecom][plugin] Skipping empty message (no text, image, file or quote)");
        return;
    }
    // Step 2: 群组策略检查（仅群聊）
    if (chatType === "group") {
        const groupPolicyResult = checkGroupPolicy({
            chatId,
            senderId: body.from.userid,
            account,
            runtime,
        });
        if (!groupPolicyResult.allowed) {
            return;
        }
    }
    // Step 3: DM Policy 访问控制检查（仅私聊）
    const dmPolicyResult = await checkDmPolicy({
        senderId: body.from.userid,
        isGroup: chatType === "group",
        account,
        wsClient,
        frame,
        runtime,
        pairing,
    });
    if (!dmPolicyResult.allowed) {
        return;
    }
    // Step 4: 下载并保存图片和文件
    const [imageMediaList, fileMediaList] = await Promise.all([
        downloadAndSaveImages({
            imageUrls,
            imageAesKeys,
            account,
            runtime,
            wsClient,
            media,
        }),
        downloadAndSaveFiles({
            fileUrls,
            fileAesKeys,
            account,
            runtime,
            wsClient,
            media,
        }),
    ]);
    const mediaList = [...imageMediaList, ...fileMediaList];
    // Step 5: 初始化消息状态
    setReqIdForChat(chatId, reqId, account.accountId);
    const streamId = generateReqId("stream");
    const state = { accumulatedText: "", streamId };
    setMessageState(messageId, state);
    const cleanupState = () => {
        deleteMessageState(messageId);
    };
    // // Step 6: 发送"思考中"消息
    // const shouldSendThinking = account.sendThinkingMessage ?? true;
    // if (shouldSendThinking) {
    //   await sendThinkingReply({ wsClient, frame, streamId, runtime });
    // }
    // Step 7: 构建进站消息并路由到核心处理流程
    const inboundMsg = buildInboundMessage(frame, text, mediaList, quoteContent);
    try {
        await routeAndDispatchMessage({
            inboundMsg,
            account,
            wsClient,
            frame,
            state,
            runtime,
            dispatch,
            onCleanup: cleanupState,
        });
    }
    catch (err) {
        runtime.error?.(`[wecom][plugin] Message processing failed: ${String(err)}`);
        cleanupState();
    }
}
// ============================================================================
// 创建 SDK Logger 适配器
// ============================================================================
/**
 * 创建适配 RuntimeEnv 的 Logger
 */
function createSdkLogger(runtime, accountId) {
    return {
        debug: (message, ...args) => {
            runtime.log?.(`[${accountId}] ${message}`, ...args);
        },
        info: (message, ...args) => {
            runtime.log?.(`[${accountId}] ${message}`, ...args);
        },
        warn: (message, ...args) => {
            runtime.log?.(`[${accountId}] WARN: ${message}`, ...args);
        },
        error: (message, ...args) => {
            runtime.error?.(`[${accountId}] ${message}`, ...args);
        },
    };
}
// ============================================================================
// 主函数
// ============================================================================
/**
 * 监听企业微信 WebSocket 连接
 * 使用 aibot-node-sdk 简化连接管理
 */
async function monitorWeComProvider(options) {
    // PISKIE 收编改动：config（OpenClawConfig）移除；media/pairing/dispatch 由框架提供
    const { account, runtime, abortSignal, setStatus, media, pairing, dispatch } = options;
    runtime.log?.(`[${account.accountId}] [${PLUGIN_VERSION}] Initializing WSClient with SDK...`);
    runtime.error?.(`[${account.accountId}] [diag] monitor boot marker: build=20260325-event-debug-1`);
    // 启动消息状态定期清理
    startMessageStateCleanup();
    return new Promise((resolve, reject) => {
        const logger = createSdkLogger(runtime, account.accountId);
        const wsClient = new WSClient({
            botId: account.botId,
            secret: account.secret,
            wsUrl: account.websocketUrl,
            logger,
            heartbeatInterval: WS_HEARTBEAT_INTERVAL_MS,
            maxReconnectAttempts: WS_MAX_RECONNECT_ATTEMPTS,
            maxAuthFailureAttempts: WS_MAX_AUTH_FAILURE_ATTEMPTS,
            scene: SCENE_WECOM_OPENCLAW,
            plug_version: PLUGIN_VERSION,
        });
        // 防止 cleanup 被多次调用（abort handler、error handler、disconnected_event 可能竞态触发）
        let cleanedUp = false;
        // 清理函数：确保所有资源被释放（幂等）
        const cleanup = async () => {
            if (cleanedUp)
                return;
            cleanedUp = true;
            stopMessageStateCleanup();
            await cleanupAccount(account.accountId);
        };
        // 处理中止信号（框架 stopChannel 会触发 abort）
        // resolve() 让 Promise settle → 框架清理 store.tasks/store.aborts
        if (abortSignal) {
            // PISKIE: pre-aborted 立即 settle（49号 §3.2.1）——已 abort 的 signal 不会再触发 listener，
            // 否则 Promise 永远 pending，停止 barrier 必然 10s 超时
            if (abortSignal.aborted) {
                runtime.log?.(`[${account.accountId}] Connection aborted before start`);
                wsClient.disconnect();
                cleanup().finally(() => resolve());
                return;
            }
            abortSignal.addEventListener("abort", async () => {
                runtime.log?.(`[${account.accountId}] Connection aborted`);
                wsClient.disconnect();
                await cleanup();
                resolve();
            }, { once: true });
        }
        // 监听连接事件
        wsClient.on("connected", () => {
            runtime.log?.(`[${account.accountId}] WebSocket connected`);
        });
        // 监听认证成功事件
        wsClient.on("authenticated", () => {
            runtime.log?.(`[${account.accountId}] Authentication successful`);
            setWeComWebSocket(account.accountId, wsClient);
        });
        // 监听断开事件
        wsClient.on("disconnected", (reason) => {
            runtime.log?.(`[${account.accountId}] WebSocket disconnected: ${reason}`);
        });
        // 监听被踢下线事件（服务端因新连接建立而主动断开旧连接）
        //
        // SDK 内部已设置 isManualClose=true 阻止 SDK 层自动重连，连接不会自行恢复。
        // **不 reject/resolve Promise**——保持 pending 以阻止框架层 auto-restart。
        //
        // 为什么不能 reject/resolve：
        //   - reject → 框架 auto-restart 介入 → 新连接建立 → 又被踢 → 两个实例互踢无限循环
        //   - resolve → 同上，框架 .then() 中的 auto-restart 也会触发
        //
        // Promise pending 的安全性：
        //   - store.tasks.has(id) = true → 阻止 Health Monitor 直接 startChannel（startChannel 检查 tasks.has）
        //   - 框架 stopChannel → abort() → abort handler 中 resolve() → tasks 正常清理
        //   - 用户修改配置 → config reload → stopChannel + startChannel → 正常恢复
        //
        // 显式调用 wsClient.disconnect() 确保 SDK 内部资源（定时器、队列等）完全释放。
        wsClient.on("event.disconnected_event", async () => {
            const errorMsg = `Kicked by server: a new connection was established elsewhere. Auto-restart is suppressed to avoid mutual kicking. Please check for duplicate instances.`;
            runtime.error?.(`[${account.accountId}] ${errorMsg}`);
            wsClient.disconnect();
            await cleanup();
            setStatus?.({
                accountId: account.accountId,
                running: false,
                lastError: errorMsg,
                lastStopAt: Date.now(),
            });
            // Promise 保持 pending，不触发 auto-restart
        });
        // 监听重连事件
        wsClient.on("reconnecting", (attempt) => {
            runtime.log?.(`[${account.accountId}] Reconnecting attempt ${attempt}...`);
        });
        // 监听错误事件
        wsClient.on("error", async (error) => {
            runtime.error?.(`[${account.accountId}] WebSocket error: ${error.message}`);
            if (error instanceof WSAuthFailureError) {
                // 认证失败重试次数用尽（SDK 层已重试 WS_MAX_AUTH_FAILURE_ATTEMPTS 次）。
                // 配置错误（如 botId/secret 无效），框架 auto-restart 也无法恢复。
                //
                // **不 reject/resolve Promise**——保持 pending 以阻止框架层 auto-restart。
                //
                // 为什么不能 reject/resolve：
                //   - reject/resolve → 框架 auto-restart（最多 10 次）× SDK 重试（5 次）= 60 次无意义尝试
                //   - 且 Health Monitor 每小时还会 resetRestartAttempts 再来一轮
                //
                // Promise pending 的安全性：同被踢下线场景
                //   - store.tasks.has(id) = true → 阻止 Health Monitor 直接 startChannel
                //   - 框架 stopChannel / config reload → abort handler 中 resolve() → 正常清理
                //   - 用户修改配置后框架通过 reload 机制重新启动
                const errorMsg = `Auth failure attempts exhausted (${WS_MAX_AUTH_FAILURE_ATTEMPTS} attempts). Please check botId/secret configuration.`;
                runtime.error?.(`[${account.accountId}] ${errorMsg}`);
                wsClient.disconnect();
                await cleanup();
                setStatus?.({
                    accountId: account.accountId,
                    running: false,
                    lastError: errorMsg,
                    lastStopAt: Date.now(),
                });
                return;
            }
            if (error instanceof WSReconnectExhaustedError) {
                // 网络断线重连次数用尽（SDK 层已重试 WS_MAX_RECONNECT_ATTEMPTS 次）。
                // 通常是网络/服务端问题，框架 auto-restart 可能恢复。
                //
                // reject Promise → 框架 auto-restart 介入（最多 MAX_RESTART_ATTEMPTS=10 次）
                // 总连接尝试次数 = (1 首次 + WS_MAX_RECONNECT_ATTEMPTS 重连) × (1 首轮 + 10 auto-restart)
                //                = 11 × 11 = 121 次
                //
                // 如果 Health Monitor 介入（每 5 分钟检查），会 resetRestartAttempts 重新计数，
                // 受限于 DEFAULT_MAX_RESTARTS_PER_HOUR=10，每小时最多额外 10 × 121 = 1210 次。
                // 但因网络断线通常是暂时性的，auto-restart + Health Monitor 的兜底机制是合理的。
                //
                // 显式调用 wsClient.disconnect() 确保 SDK 内部资源完全释放，
                // 避免旧实例的定时器/队列残留。
                wsClient.disconnect();
                cleanup().finally(() => reject(error));
                return;
            }
        });
        // 监听版本检查事件：收到 enter_check_update 时回复当前插件版本
        wsClient.on(EVENT_ENTER_CHECK_UPDATE, async (frame) => {
            try {
                // runtime.log?.(`[${account.accountId}] Received enter_check_update, replying with version=${PLUGIN_VERSION}`);
                await wsClient.reply(frame, { version: PLUGIN_VERSION }, CMD_ENTER_EVENT_REPLY);
            }
            catch (err) {
                // runtime.error?.(`[${account.accountId}] Failed to reply enter_check_update: ${String(err)}`);
            }
        });
        // 监听普通消息
        wsClient.on("message", async (frame) => {
            try {
                await processWeComMessage({
                    frame,
                    account,
                    runtime,
                    wsClient,
                    media,
                    pairing,
                    dispatch,
                });
            }
            catch (err) {
                runtime.error?.(`[${account.accountId}] Failed to process message: ${String(err)}`);
            }
        });
        // 监听所有事件回调（aibot_event_callback）。
        // 这里使用通用 event 监听，再按 eventtype 分发，兼容不同 SDK 版本在细分事件名上的差异。
        wsClient.on("event", async (frame) => {
            try {
                const eventBody = frame.body;
                const eventType = eventBody.event?.eventtype;
                runtime.log?.(`[${account.accountId}] Received event callback: eventtype=${eventType ?? ""}, msgid=${eventBody.msgid ?? ""}`);
                runtime.error?.(`[${account.accountId}] [diag] event-listener fired: eventtype=${eventType ?? ""}, msgid=${eventBody.msgid ?? ""}`);
                if (eventType !== "template_card_event") {
                    return;
                }
                const templateCardEvent = eventBody.event?.template_card_event;
                runtime.log?.(`[${account.accountId}] Received template_card_event: event_key=${templateCardEvent?.event_key ?? ""}, task_id=${templateCardEvent?.task_id ?? ""}`);
                try {
                    await updateTemplateCardOnEvent({
                        frame,
                        accountId: account.accountId,
                        runtime,
                        wsClient,
                    });
                }
                catch (updateErr) {
                    runtime.error?.(`[${account.accountId}] [template-card-update] Failed to update template card: ${String(updateErr)}`);
                }
                await processWeComMessage({
                    frame,
                    account,
                    runtime,
                    wsClient,
                    media,
                    pairing,
                    dispatch,
                });
            }
            catch (err) {
                runtime.error?.(`[${account.accountId}] Failed to process template_card_event: ${String(err)}`);
            }
        });
        runtime.log?.(`[${account.accountId}] Event listeners attached: message + event(template_card_event)`);
        runtime.error?.(`[${account.accountId}] [diag] listeners-ready marker`);
        // 启动前预热 reqId 缓存，确保完成后再建立连接，避免 getSync 在预热完成前返回 undefined
        warmupReqIdStore(account.accountId, (...args) => runtime.log?.(...args))
            .then((count) => {
            runtime.log?.(`[${account.accountId}] Warmed up ${count} reqId entries from disk`);
        })
            .catch((err) => {
            runtime.error?.(`[${account.accountId}] Failed to warmup reqId store: ${String(err)}`);
        })
            .finally(() => {
            // 无论预热成功或失败，都建立连接
            // PISKIE: abort 后不再建立连接（49号 §3.2.1）——Promise 已 settle，此时 connect 会泄漏 WS
            if (abortSignal?.aborted)
                return;
            wsClient.connect();
        });
    });
}

export { monitorWeComProvider, sendWeComReply, setReqIdForChat, warmupReqIdStore };
