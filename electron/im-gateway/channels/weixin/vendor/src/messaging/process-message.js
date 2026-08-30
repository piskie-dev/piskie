import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTypingCallbacks } from "../../../../../core/openclaw-compat/channel-runtime.js";
import { resolveSenderCommandAuthorizationWithRuntime, resolveDirectDmAuthorizationOutcome, } from "../../../../../core/openclaw-compat/command-auth.js";
import { resolvePreferredOpenClawTmpDir } from "../../../../../core/openclaw-compat/infra-runtime.js";
import { sendTyping } from "../api/api.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { loadWeixinAccount } from "../auth/accounts.js";
import { readFrameworkAllowFromList } from "../auth/pairing.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { logger } from "../util/logger.js";
import { redactBody, redactToken } from "../util/redact.js";
import { isDebugMode } from "./debug-mode.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { applyWeixinMessageSendingHook, emitWeixinMessageSent } from "./outbound-hooks.js";
import { setContextToken, weixinMessageToMsgContext, getContextTokenFromMsgContext, isMediaItem, } from "./inbound.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { StreamingMarkdownFilter } from "./markdown-filter.js";
import { sendMessageItemWeixin, sendMessageWeixin } from "./send.js";
import { handleSlashCommand } from "./slash-commands.js";
const MEDIA_OUTBOUND_TEMP_DIR = path.join(resolvePreferredOpenClawTmpDir(), "weixin/media/outbound-temp");
/** Extract text body from item_list (for slash command detection). */
function extractTextBody(itemList) {
    if (!itemList?.length)
        return "";
    for (const item of itemList) {
        if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
            return String(item.text_item.text);
        }
    }
    return "";
}
export function cleanupDownloadedMediaOpts(mediaOpts) {
    const paths = [
        mediaOpts?.decryptedPicPath,
        mediaOpts?.decryptedVoicePath,
        mediaOpts?.decryptedFilePath,
        mediaOpts?.decryptedVideoPath,
    ];
    for (const filePath of paths) {
        if (!filePath || filePath.startsWith("download-failed://"))
            continue;
        try {
            fs.unlinkSync(filePath);
        }
        catch {
            // Cleanup is idempotent; the core may already have removed the file.
        }
    }
}
function normalizeToolProgressStatus(status) {
    return status === "completed" || status === "failed" || status === "blocked"
        ? status
        : "blocked";
}
export function installToolProgressCapability(dispatcher) {
    const openTools = new Map();
    const enqueue = dispatcher.sendToolResult.bind(dispatcher);
    const capability = {
        start(event) {
            if (!event.toolCallId || !event.toolName || openTools.has(event.toolCallId))
                return false;
            const queued = enqueue({
                toolProgress: {
                    phase: "start",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                },
            });
            if (queued)
                openTools.set(event.toolCallId, event.toolName);
            return queued;
        },
        complete(event) {
            const toolName = openTools.get(event.toolCallId);
            if (!toolName)
                return false;
            openTools.delete(event.toolCallId);
            return enqueue({
                toolProgress: {
                    phase: "result",
                    toolCallId: event.toolCallId,
                    toolName,
                    status: normalizeToolProgressStatus(event.status),
                },
            });
        },
        closeOpen(status) {
            const snapshot = [...openTools.entries()];
            openTools.clear();
            let queued = 0;
            for (const [toolCallId, toolName] of snapshot) {
                if (enqueue({
                    toolProgress: {
                        phase: "result",
                        toolCallId,
                        toolName,
                        status: normalizeToolProgressStatus(status),
                    },
                })) {
                    queued += 1;
                }
            }
            return queued;
        },
    };
    dispatcher.toolProgress = capability;
    return capability;
}
export function buildToolProgressItem(frame) {
    const now = Date.now();
    if (frame.phase === "start") {
        return {
            type: MessageItemType.TOOL_CALL_START,
            create_time_ms: now,
            is_completed: false,
            tool_call_start_item: {
                tool_name: frame.toolName,
                tool_call_id: frame.toolCallId,
            },
        };
    }
    return {
        type: MessageItemType.TOOL_CALL_RESULT,
        create_time_ms: now,
        is_completed: true,
        tool_call_result_item: {
            tool_name: frame.toolName,
            tool_call_id: frame.toolCallId,
            status: normalizeToolProgressStatus(frame.status),
        },
    };
}
/**
 * Process a single inbound message: route → download media → dispatch reply.
 * Extracted from the monitor loop to keep monitoring and message handling separate.
 */
export async function processOneMessage(full, deps) {
    if (!deps?.channelRuntime) {
        logger.error(`processOneMessage: channelRuntime is undefined, skipping message from=${full.from_user_id}`);
        deps.errLog("processOneMessage: channelRuntime is undefined, skip");
        return;
    }
    const receivedAt = Date.now();
    const debug = isDebugMode(deps.accountId);
    const debugTrace = [];
    const debugTs = { received: receivedAt };
    const textBody = extractTextBody(full.item_list);
    if (textBody.startsWith("/")) {
        const slashResult = await handleSlashCommand(textBody, {
            to: full.from_user_id ?? "",
            contextToken: full.context_token,
            baseUrl: deps.baseUrl,
            token: deps.token,
            accountId: deps.accountId,
            abortSignal: deps.abortSignal,
            log: deps.log,
            errLog: deps.errLog,
        }, receivedAt, full.create_time_ms);
        if (slashResult.handled) {
            logger.info(`[weixin] Slash command handled, skipping AI pipeline`);
            return;
        }
    }
    if (debug) {
        const itemTypes = full.item_list?.map((i) => i.type).join(",") ?? "none";
        debugTrace.push("── 收消息 ──", `│ seq=${full.seq ?? "?"} msgId=${full.message_id ?? "?"} from=${full.from_user_id ?? "?"}`, `│ body="${textBody.slice(0, 40)}${textBody.length > 40 ? "…" : ""}" (len=${textBody.length}) itemTypes=[${itemTypes}]`, `│ sessionId=${full.session_id ?? "?"} contextToken=${full.context_token ? "present" : "none"}`);
    }
    const mediaOpts = {};
    // Find the first downloadable media item (priority: IMAGE > VIDEO > FILE > VOICE).
    // When none found in the main item_list, fall back to media referenced via a quoted message.
    const hasDownloadableMedia = (m) => m?.encrypt_query_param || m?.full_url;
    const mainMediaItem = full.item_list?.find((i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media)) ??
        full.item_list?.find((i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media)) ??
        full.item_list?.find((i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media)) ??
        full.item_list?.find((i) => i.type === MessageItemType.VOICE &&
            hasDownloadableMedia(i.voice_item?.media) &&
            !i.voice_item?.text);
    const refMediaItem = !mainMediaItem
        ? full.item_list?.find((i) => i.type === MessageItemType.TEXT &&
            i.ref_msg?.message_item &&
            isMediaItem(i.ref_msg.message_item))?.ref_msg?.message_item
        : undefined;
    const mediaDownloadStart = Date.now();
    const mediaItem = mainMediaItem ?? refMediaItem;
    if (mediaItem) {
        const label = refMediaItem ? "ref" : "inbound";
        const downloaded = await downloadMediaFromItem(mediaItem, {
            cdnBaseUrl: deps.cdnBaseUrl,
            saveMedia: deps.channelRuntime.media.saveMediaBuffer,
            log: deps.log,
            errLog: deps.errLog,
            label,
            abortSignal: deps.abortSignal,
        });
        Object.assign(mediaOpts, downloaded);
    }
    const mediaDownloadMs = Date.now() - mediaDownloadStart;
    if (debug) {
        debugTrace.push(mediaItem
            ? `│ mediaDownload: type=${mediaItem.type} cost=${mediaDownloadMs}ms`
            : "│ mediaDownload: none");
    }
    let mediaHandedOff = false;
    try {
    if (deps.abortSignal?.aborted)
        return;
    const ctx = weixinMessageToMsgContext(full, deps.accountId, mediaOpts);
    // --- Framework command authorization ---
    const rawBody = ctx.Body?.trim() ?? "";
    ctx.CommandBody = rawBody;
    const senderId = full.from_user_id ?? "";
    ctx.SenderId = senderId;
    const { senderAllowedForCommands, commandAuthorized } = await resolveSenderCommandAuthorizationWithRuntime({
        cfg: deps.config,
        rawBody,
        isGroup: false,
        dmPolicy: "pairing",
        configuredAllowFrom: [],
        configuredGroupAllowFrom: [],
        senderId,
        isSenderAllowed: (id, list) => list.length === 0 || list.includes(id),
        /** Pairing: framework credentials `*-allowFrom.json`, with account `userId` fallback for legacy installs. */
        readAllowFromStore: async () => {
            const fromStore = readFrameworkAllowFromList(deps.accountId);
            if (fromStore.length > 0)
                return fromStore;
            const uid = loadWeixinAccount(deps.accountId)?.userId?.trim();
            return uid ? [uid] : [];
        },
        runtime: deps.channelRuntime.commands,
    });
    const directDmOutcome = resolveDirectDmAuthorizationOutcome({
        isGroup: false,
        dmPolicy: "pairing",
        senderAllowedForCommands,
    });
    if (directDmOutcome === "disabled" || directDmOutcome === "unauthorized") {
        logger.info(`authorization: dropping message from=${senderId} outcome=${directDmOutcome}`);
        return;
    }
    ctx.CommandAuthorized = commandAuthorized;
    logger.debug(`authorization: senderId=${senderId} commandAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowedForCommands)}`);
    if (debug) {
        debugTrace.push("── 鉴权 & 路由 ──", `│ auth: cmdAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowedForCommands)}`);
    }
    const route = deps.channelRuntime.routing.resolveAgentRoute({
        cfg: deps.config,
        channel: "openclaw-weixin",
        accountId: deps.accountId,
        peer: { kind: "direct", id: ctx.To },
    });
    logger.debug(`resolveAgentRoute: agentId=${route.agentId ?? "(none)"} sessionKey=${route.sessionKey ?? "(none)"} mainSessionKey=${route.mainSessionKey ?? "(none)"}`);
    if (!route.agentId) {
        logger.error(`resolveAgentRoute: no agentId resolved for peer=${ctx.To} accountId=${deps.accountId} — message will not be dispatched`);
    }
    if (debug) {
        debugTrace.push(`│ route: agent=${route.agentId ?? "none"} session=${route.sessionKey ?? "none"}`);
        debugTs.preDispatch = Date.now();
    }
    // Propagate the resolved session key into ctx so dispatchReplyFromConfig uses
    // the correct session (matching the dmScope from config) instead of falling back
    // to agent:main:main.
    ctx.SessionKey = route.sessionKey;
    const storePath = deps.channelRuntime.session.resolveStorePath(deps.config.session?.store, {
        agentId: route.agentId,
    });
    const finalized = deps.channelRuntime.reply.finalizeInboundContext(ctx);
    logger.info(`inbound: from=${finalized.From} to=${finalized.To} bodyLen=${(finalized.Body ?? "").length} hasMedia=${Boolean(finalized.MediaPath ?? finalized.MediaUrl)}`);
    logger.debug(`inbound context: ${redactBody(JSON.stringify(finalized))}`);
    await deps.channelRuntime.session.recordInboundSession({
        storePath,
        sessionKey: route.sessionKey,
        ctx: finalized,
        updateLastRoute: {
            sessionKey: route.mainSessionKey,
            channel: "openclaw-weixin",
            to: ctx.To,
            accountId: deps.accountId,
        },
        onRecordError: (err) => deps.errLog(`recordInboundSession: ${String(err)}`),
    });
    logger.debug(`recordInboundSession: done storePath=${storePath} sessionKey=${route.sessionKey ?? "(none)"}`);
    const contextToken = getContextTokenFromMsgContext(ctx);
    if (contextToken) {
        setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
    }
    // Core IM commands are direct acknowledgements, not Agent runs.
    const runId = /^\/clear(?:\s|$)/i.test(textBody.trim()) ? undefined : randomUUID();
    const humanDelay = deps.channelRuntime.reply.resolveHumanDelayConfig(deps.config, route.agentId);
    const hasTypingTicket = Boolean(deps.typingTicket);
    const typingCallbacks = createTypingCallbacks({
        start: hasTypingTicket
            ? () => sendTyping({
                baseUrl: deps.baseUrl,
                token: deps.token,
                abortSignal: deps.abortSignal,
                body: {
                    ilink_user_id: ctx.To,
                    typing_ticket: deps.typingTicket,
                    status: TypingStatus.TYPING,
                },
            })
            : async () => { },
        stop: hasTypingTicket
            ? () => sendTyping({
                baseUrl: deps.baseUrl,
                token: deps.token,
                abortSignal: deps.abortSignal,
                body: {
                    ilink_user_id: ctx.To,
                    typing_ticket: deps.typingTicket,
                    status: TypingStatus.CANCEL,
                },
            })
            : async () => { },
        onStartError: (err) => deps.log(`[weixin] typing send error: ${String(err)}`),
        onStopError: (err) => deps.log(`[weixin] typing cancel error: ${String(err)}`),
        keepaliveIntervalMs: 5000,
    });
    /** Delivery records populated synchronously at deliver() entry, safe to read in finally. */
    const debugDeliveries = [];
    const { dispatcher, replyOptions, markDispatchIdle } = deps.channelRuntime.reply.createReplyDispatcherWithTyping({
        humanDelay,
        typingCallbacks,
        deliver: async (payload) => {
            if (payload.toolProgress) {
                const frame = payload.toolProgress;
                try {
                    await sendMessageItemWeixin({
                        to: ctx.To,
                        item: buildToolProgressItem(frame),
                        opts: {
                            baseUrl: deps.baseUrl,
                            token: deps.token,
                            contextToken,
                            runId,
                            abortSignal: deps.abortSignal,
                        },
                        label: frame.phase === "start"
                            ? "sendToolCallStartMessage"
                            : "sendToolCallResultMessage",
                    });
                    logger.info(`outbound: tool progress sent phase=${frame.phase} runId=${redactToken(runId)} toolCallId=${redactToken(frame.toolCallId)}`);
                }
                catch (cause) {
                    const error = new Error("weixin tool progress send failed");
                    error.code = "WEIXIN_TOOL_PROGRESS_SEND_FAILED";
                    error.cause = cause;
                    throw error;
                }
                return;
            }
            const rawText = payload.text ?? "";
            let text = (() => {
                const f = new StreamingMarkdownFilter();
                return f.feed(rawText) + f.flush();
            })();
            const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
            logger.debug(`outbound payload: ${redactBody(JSON.stringify(payload))}`);
            logger.info(`outbound: to=${ctx.To} contextToken=${redactToken(contextToken)} textLen=${text.length} mediaUrl=${mediaUrl ? "present" : "none"}`);
            if (debug) {
                debugDeliveries.push({
                    textLen: text.length,
                    media: mediaUrl ? "present" : "none",
                    preview: `${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`,
                    ts: Date.now(),
                });
            }
            const sendingResult = await applyWeixinMessageSendingHook({
                to: ctx.To,
                text,
                accountId: deps.accountId,
                mediaUrl,
                runId,
            });
            if (sendingResult.cancelled) {
                logger.info(`outbound: cancelled by message_sending hook to=${ctx.To}`);
                return;
            }
            text = sendingResult.text;
            try {
                if (mediaUrl) {
                    let filePath;
                    if (!mediaUrl.includes("://") || mediaUrl.startsWith("file://")) {
                        if (mediaUrl.startsWith("file://")) {
                            filePath = new URL(mediaUrl).pathname;
                        }
                        else if (!path.isAbsolute(mediaUrl)) {
                            filePath = path.resolve(mediaUrl);
                            logger.debug(`outbound: resolved relative path ${mediaUrl} -> ${filePath}`);
                        }
                        else {
                            filePath = mediaUrl;
                        }
                        logger.debug(`outbound: local file path resolved filePath=${filePath}`);
                    }
                    else if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
                        logger.debug(`outbound: downloading remote mediaUrl=${mediaUrl.slice(0, 80)}...`);
                        filePath = await downloadRemoteImageToTemp(mediaUrl, MEDIA_OUTBOUND_TEMP_DIR, deps.abortSignal);
                        logger.debug(`outbound: remote image downloaded to filePath=${filePath}`);
                    }
                    else {
                        logger.warn(`outbound: unrecognized mediaUrl scheme, sending text only mediaUrl=${mediaUrl.slice(0, 80)}`);
                        await sendMessageWeixin({ to: ctx.To, text, opts: {
                                baseUrl: deps.baseUrl,
                                token: deps.token,
                                contextToken,
                                runId,
                                abortSignal: deps.abortSignal,
                            } });
                        emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
                        logger.info(`outbound: text sent to=${ctx.To}`);
                        return;
                    }
                    await sendWeixinMediaFile({
                        filePath,
                        to: ctx.To,
                        text,
                        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId, abortSignal: deps.abortSignal },
                        cdnBaseUrl: deps.cdnBaseUrl,
                    });
                    emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
                    logger.info(`outbound: media sent OK to=${ctx.To}`);
                }
                else {
                    logger.debug(`outbound: sending text message to=${ctx.To}`);
                    await sendMessageWeixin({ to: ctx.To, text, opts: {
                            baseUrl: deps.baseUrl,
                            token: deps.token,
                            contextToken,
                            runId,
                            abortSignal: deps.abortSignal,
                        } });
                    emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
                    logger.info(`outbound: text sent OK to=${ctx.To}`);
                }
            }
            catch (err) {
                emitWeixinMessageSent({ to: ctx.To, content: text, success: false, error: String(err), accountId: deps.accountId, runId });
                logger.error(`outbound: FAILED to=${ctx.To} mediaUrl=${mediaUrl ?? "none"} err=${String(err)} stack=${err.stack ?? ""}`);
                throw err;
            }
        },
        onError: (err, info) => {
            deps.errLog(`weixin reply ${info.kind}: ${String(err)}`);
            if (err?.code === "WEIXIN_TOOL_PROGRESS_SEND_FAILED")
                return;
            const errMsg = err instanceof Error ? err.message : String(err);
            let notice;
            if (errMsg.includes("remote media download failed") || errMsg.includes("fetch")) {
                notice = `⚠️ 媒体文件下载失败，请检查链接是否可访问。`;
            }
            else if (errMsg.includes("getUploadUrl") ||
                errMsg.includes("CDN upload") ||
                errMsg.includes("upload_param")) {
                notice = `⚠️ 媒体文件上传失败，请稍后重试。`;
            }
            else {
                notice = `⚠️ 消息发送失败：${errMsg}`;
            }
            void sendWeixinErrorNotice({
                to: ctx.To,
                contextToken,
                message: notice,
                baseUrl: deps.baseUrl,
                token: deps.token,
                runId,
                abortSignal: deps.abortSignal,
                errLog: deps.errLog,
            });
        },
    });
    installToolProgressCapability(dispatcher);
    logger.debug(`dispatchReplyFromConfig: starting agentId=${route.agentId ?? "(none)"}`);
    mediaHandedOff = true;
    try {
        await deps.channelRuntime.reply.withReplyDispatcher({
            dispatcher,
            run: () => deps.channelRuntime.reply.dispatchReplyFromConfig({
                ctx: finalized,
                cfg: deps.config,
                dispatcher,
                replyOptions: {
                    ...replyOptions,
                    disableBlockStreaming: true,
                },
            }),
        });
        logger.debug(`dispatchReplyFromConfig: done agentId=${route.agentId ?? "(none)"}`);
    }
    catch (err) {
        logger.error(`dispatchReplyFromConfig: error agentId=${route.agentId ?? "(none)"} err=${String(err)}`);
        throw err;
    }
    finally {
        markDispatchIdle();
        logger.info(`debug-check: accountId=${deps.accountId} debug=${String(debug)} hasContextToken=${Boolean(contextToken)}`);
        if (debug && contextToken) {
            const dispatchDoneAt = Date.now();
            const eventTs = full.create_time_ms ?? 0;
            const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
            const inboundProcessMs = (debugTs.preDispatch ?? receivedAt) - receivedAt;
            const aiMs = dispatchDoneAt - (debugTs.preDispatch ?? receivedAt);
            const totalTime = eventTs > 0 ? `${dispatchDoneAt - eventTs}ms` : `${dispatchDoneAt - receivedAt}ms`;
            if (debugDeliveries.length > 0) {
                debugTrace.push("── 回复 ──");
                for (const d of debugDeliveries) {
                    debugTrace.push(`│ textLen=${d.textLen} media=${d.media}`, `│ text="${d.preview}"`);
                }
                const firstTs = debugDeliveries[0].ts;
                debugTrace.push(`│ deliver耗时: ${dispatchDoneAt - firstTs}ms`);
            }
            else {
                debugTrace.push("── 回复 ──", "│ (deliver未捕获)");
            }
            debugTrace.push("── 耗时 ──", `├ 平台→插件: ${platformDelay}`, `├ 入站处理(auth+route+media): ${inboundProcessMs}ms (mediaDownload: ${mediaDownloadMs}ms)`, `├ AI生成+回复: ${aiMs}ms`, `├ 总耗时: ${totalTime}`, `└ eventTime: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`);
            const timingText = `⏱ Debug 全链路\n${debugTrace.join("\n")}`;
            logger.info(`debug-timing: sending to=${ctx.To}`);
            try {
                await sendMessageWeixin({
                    to: ctx.To,
                    text: timingText,
                    opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId, abortSignal: deps.abortSignal },
                });
                logger.info(`debug-timing: sent OK`);
            }
            catch (debugErr) {
                logger.error(`debug-timing: send FAILED err=${String(debugErr)}`);
            }
        }
    }
    }
    finally {
        if (!mediaHandedOff)
            cleanupDownloadedMediaOpts(mediaOpts);
    }
}
