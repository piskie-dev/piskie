"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Streaming card controller for the Lark/Feishu channel plugin.
 *
 * Manages the full lifecycle of a streaming CardKit card:
 * idle → creating → streaming → completed / aborted / terminated.
 *
 * Delegates throttling to FlushController and message-unavailable
 * detection to UnavailableGuard.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamingCardController = void 0;
exports.prepareTerminalCardContent = prepareTerminalCardContent;
const promises_1 = require("node:fs/promises");
const reply_runtime_1 = require("../../openclaw-compat/reply-runtime.js");
const api_error_1 = require("../core/api-error.js");
const lark_logger_1 = require("../core/lark-logger.js");
const lark_client_1 = require("../core/lark-client.js");
const shutdown_hooks_1 = require("../core/shutdown-hooks.js");
const send_1 = require("../messaging/outbound/send.js");
const builder_1 = require("./builder.js");
const card_error_1 = require("./card-error.js");
const cardkit_1 = require("./cardkit.js");
const flush_controller_1 = require("./flush-controller.js");
const image_resolver_1 = require("./image-resolver.js");
const markdown_style_1 = require("./markdown-style.js");
const reply_dispatcher_types_1 = require("./reply-dispatcher-types.js");
const unavailable_guard_1 = require("./unavailable-guard.js");
const log = (0, lark_logger_1.larkLogger)('card/streaming');
// ---------------------------------------------------------------------------
// CardKit 2.0 initial streaming payload
// ---------------------------------------------------------------------------
const STREAMING_THINKING_CARD = {
    schema: '2.0',
    config: {
        streaming_mode: true,
        // locales 用于支持多语言摘要展示
        locales: ['zh_cn', 'en_us'],
        summary: {
            content: 'Thinking...',
            i18n_content: { zh_cn: '思考中...', en_us: 'Thinking...' },
        },
    },
    body: {
        elements: [
            {
                tag: 'markdown',
                content: '',
                text_align: 'left',
                text_size: 'normal_v2',
                margin: '0px 0px 0px 0px',
                element_id: builder_1.STREAMING_ELEMENT_ID,
            },
            {
                tag: 'markdown',
                content: ' ',
                icon: {
                    tag: 'custom_icon',
                    img_key: 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg',
                    size: '16px 16px',
                },
                element_id: 'loading_icon',
            },
        ],
    },
};
// ---------------------------------------------------------------------------
// StreamingCardController
// ---------------------------------------------------------------------------
class StreamingCardController {
    // ---- Explicit state machine ----
    phase = 'idle';
    // ---- Structured state ----
    cardKit = {
        cardKitCardId: null,
        originalCardKitCardId: null,
        cardKitSequence: 0,
        cardMessageId: null,
    };
    text = {
        accumulatedText: '',
        completedText: '',
        streamingPrefix: '',
        lastPartialText: '',
    };
    reasoning = {
        accumulatedReasoningText: '',
        reasoningStartTime: null,
        reasoningElapsedMs: 0,
        isReasoningPhase: false,
    };
    // ---- Sub-controllers ----
    flush;
    guard;
    imageResolver;
    // ---- Lifecycle ----
    createEpoch = 0;
    _terminalReason = null;
    dispatchFullyComplete = false;
    cardCreationPromise = null;
    disposeShutdownHook = null;
    dispatchStartTime = Date.now();
    // ---- Injected dependencies ----
    deps;
    elapsed() {
        return Date.now() - this.dispatchStartTime;
    }
    needsFooterMetrics() {
        const footer = this.deps.resolvedFooter;
        return footer.tokens || footer.cache || footer.context || footer.model;
    }
    async getFooterSessionMetrics() {
        try {
            const runtime = lark_client_1.LarkClient.runtime;
            if (!runtime)
                return undefined;
            const cfgWithSession = this.deps.cfg;
            const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
            const key = this.deps.sessionKey.trim().toLowerCase();
            const sessionApi = runtime.agent?.session;
            if (sessionApi?.resolveStorePath && sessionApi?.loadSessionStore) {
                const storePath = sessionApi.resolveStorePath(sessionStorePath);
                const store = sessionApi.loadSessionStore(storePath);
                const entry = store[key];
                if (!entry || typeof entry !== 'object') {
                    log.debug('footer metrics lookup: session entry missing', {
                        sessionKey: this.deps.sessionKey,
                        normalizedSessionKey: key,
                        storePath,
                        source: 'runtime.agent.session',
                    });
                    return undefined;
                }
                const metrics = {
                    inputTokens: typeof entry.inputTokens === 'number' ? entry.inputTokens : undefined,
                    outputTokens: typeof entry.outputTokens === 'number' ? entry.outputTokens : undefined,
                    cacheRead: typeof entry.cacheRead === 'number' ? entry.cacheRead : undefined,
                    cacheWrite: typeof entry.cacheWrite === 'number' ? entry.cacheWrite : undefined,
                    totalTokens: typeof entry.totalTokens === 'number' ? entry.totalTokens : undefined,
                    totalTokensFresh: typeof entry.totalTokensFresh === 'boolean' ? entry.totalTokensFresh : undefined,
                    contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : undefined,
                    model: typeof entry.model === 'string' ? entry.model : undefined,
                };
                log.debug('footer metrics lookup: session entry found', {
                    sessionKey: this.deps.sessionKey,
                    normalizedSessionKey: key,
                    storePath,
                    source: 'runtime.agent.session',
                    hasMetrics: !!(metrics.inputTokens != null ||
                        metrics.outputTokens != null ||
                        metrics.cacheRead != null ||
                        metrics.cacheWrite != null ||
                        metrics.totalTokens != null ||
                        metrics.contextTokens != null ||
                        metrics.model),
                });
                return metrics;
            }
            const channelSession = runtime.channel?.session;
            if (!channelSession?.resolveStorePath) {
                return undefined;
            }
            const storePath = channelSession.resolveStorePath(sessionStorePath);
            const raw = await (0, promises_1.readFile)(storePath, 'utf8');
            const parsed = JSON.parse(raw);
            const store = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : {};
            const entry = store[key];
            if (!entry || typeof entry !== 'object') {
                log.debug('footer metrics lookup: session entry missing', {
                    sessionKey: this.deps.sessionKey,
                    normalizedSessionKey: key,
                    storePath,
                    source: 'channel.session.file',
                });
                return undefined;
            }
            const metrics = {
                inputTokens: typeof entry.inputTokens === 'number' ? entry.inputTokens : undefined,
                outputTokens: typeof entry.outputTokens === 'number' ? entry.outputTokens : undefined,
                cacheRead: typeof entry.cacheRead === 'number' ? entry.cacheRead : undefined,
                cacheWrite: typeof entry.cacheWrite === 'number' ? entry.cacheWrite : undefined,
                totalTokens: typeof entry.totalTokens === 'number' ? entry.totalTokens : undefined,
                totalTokensFresh: typeof entry.totalTokensFresh === 'boolean' ? entry.totalTokensFresh : undefined,
                contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : undefined,
                model: typeof entry.model === 'string' ? entry.model : undefined,
            };
            log.debug('footer metrics lookup: session entry found', {
                sessionKey: this.deps.sessionKey,
                normalizedSessionKey: key,
                storePath,
                source: 'channel.session.file',
                hasMetrics: !!(metrics.inputTokens != null ||
                    metrics.outputTokens != null ||
                    metrics.cacheRead != null ||
                    metrics.cacheWrite != null ||
                    metrics.totalTokens != null ||
                    metrics.contextTokens != null ||
                    metrics.model),
            });
            return metrics;
        }
        catch (err) {
            log.warn('footer metrics lookup failed', { error: String(err), sessionKey: this.deps.sessionKey });
            return undefined;
        }
    }
    constructor(deps) {
        this.deps = deps;
        this.guard = new unavailable_guard_1.UnavailableGuard({
            replyToMessageId: deps.replyToMessageId,
            getCardMessageId: () => this.cardKit.cardMessageId,
            onTerminate: () => {
                this.transition('terminated', 'UnavailableGuard', 'unavailable');
            },
        });
        this.flush = new flush_controller_1.FlushController(() => this.performFlush());
        this.imageResolver = new image_resolver_1.ImageResolver({
            cfg: deps.cfg,
            accountId: deps.accountId,
            onImageResolved: () => {
                if (!this.isTerminalPhase && this.cardKit.cardMessageId) {
                    void this.throttledCardUpdate();
                }
            },
        });
    }
    // ------------------------------------------------------------------
    // Public accessors
    // ------------------------------------------------------------------
    get cardMessageId() {
        return this.cardKit.cardMessageId;
    }
    get isTerminalPhase() {
        return reply_dispatcher_types_1.TERMINAL_PHASES.has(this.phase);
    }
    /**
     * Whether the card has been explicitly aborted (via abortCard()).
     *
     * Distinct from isTerminalPhase — creation_failed is NOT an abort;
     * it should allow fallthrough to static delivery in the factory.
     */
    get isAborted() {
        return this.phase === 'aborted';
    }
    /** Whether the reply pipeline was terminated due to an unavailable message. */
    get isTerminated() {
        return this.guard.isTerminated;
    }
    /** Check if the pipeline should skip further operations for this source. */
    shouldSkipForUnavailable(source) {
        return this.guard.shouldSkip(source);
    }
    /** Attempt to terminate the pipeline due to an unavailable message error. */
    terminateIfUnavailable(source, err) {
        return this.guard.terminate(source, err);
    }
    /** Why the controller entered a terminal phase, or null if still active. */
    get terminalReason() {
        return this._terminalReason;
    }
    /** @internal — exposed for test assertions only. */
    get currentPhase() {
        return this.phase;
    }
    // ------------------------------------------------------------------
    // Unified callback guard
    // ------------------------------------------------------------------
    /**
     * Unified callback guard — returns true if the pipeline is active
     * and the callback should proceed.
     *
     * Combines three checks:
     * 1. guard.isTerminated — message recalled/deleted
     * 2. guard.shouldSkip(source) — eagerly detect unavailable messages
     * 3. isTerminalPhase — completed/aborted/terminated/creation_failed
     */
    shouldProceed(source) {
        if (this.guard.isTerminated || this.guard.shouldSkip(source))
            return false;
        return !this.isTerminalPhase;
    }
    // ------------------------------------------------------------------
    // State machine
    // ------------------------------------------------------------------
    isStaleCreate(epoch) {
        return epoch !== this.createEpoch;
    }
    transition(to, source, reason) {
        const from = this.phase;
        if (from === to)
            return false;
        if (!reply_dispatcher_types_1.PHASE_TRANSITIONS[from].has(to)) {
            log.warn('phase transition rejected', { from, to, source });
            return false;
        }
        this.phase = to;
        log.info('phase transition', { from, to, source, reason });
        if (reply_dispatcher_types_1.TERMINAL_PHASES.has(to)) {
            this._terminalReason = reason ?? null;
            this.onEnterTerminalPhase();
        }
        return true;
    }
    onEnterTerminalPhase() {
        this.createEpoch += 1;
        this.flush.cancelPendingFlush();
        this.flush.complete();
        this.disposeShutdownHook?.();
        this.disposeShutdownHook = null;
    }
    // ------------------------------------------------------------------
    // SDK callback bindings
    // ------------------------------------------------------------------
    /**
     * Handle a deliver() call in streaming card mode.
     *
     * Accumulates text from the SDK's deliver callbacks to build the
     * authoritative "completedText" for the final card.
     */
    async onDeliver(payload) {
        if (!this.shouldProceed('onDeliver'))
            return;
        const text = payload.text ?? '';
        if (!text.trim())
            return;
        await this.ensureCardCreated();
        if (!this.shouldProceed('onDeliver.postCreate'))
            return;
        if (!this.cardKit.cardMessageId)
            return;
        const split = (0, builder_1.splitReasoningText)(text);
        if (split.reasoningText && !split.answerText) {
            // Pure reasoning payload
            this.reasoning.reasoningElapsedMs = this.reasoning.reasoningStartTime
                ? Date.now() - this.reasoning.reasoningStartTime
                : 0;
            this.reasoning.accumulatedReasoningText = split.reasoningText;
            this.reasoning.isReasoningPhase = true;
            await this.throttledCardUpdate();
            return;
        }
        // Answer payload (may also contain inline reasoning from tags)
        this.reasoning.isReasoningPhase = false;
        if (split.reasoningText) {
            this.reasoning.accumulatedReasoningText = split.reasoningText;
        }
        const answerText = split.answerText ?? text;
        // 累积 deliver 文本用于最终卡片
        this.text.completedText += (this.text.completedText ? '\n\n' : '') + answerText;
        // 没有流式数据时，用 deliver 文本显示在卡片上
        if (!this.text.lastPartialText && !this.text.streamingPrefix) {
            this.text.accumulatedText += (this.text.accumulatedText ? '\n\n' : '') + answerText;
            this.text.streamingPrefix = this.text.accumulatedText;
            await this.throttledCardUpdate();
        }
    }
    async onReasoningStream(payload) {
        if (!this.shouldProceed('onReasoningStream'))
            return;
        await this.ensureCardCreated();
        if (!this.shouldProceed('onReasoningStream.postCreate'))
            return;
        if (!this.cardKit.cardMessageId)
            return;
        const rawText = payload.text ?? '';
        if (!rawText)
            return;
        if (!this.reasoning.reasoningStartTime) {
            this.reasoning.reasoningStartTime = Date.now();
        }
        this.reasoning.isReasoningPhase = true;
        const split = (0, builder_1.splitReasoningText)(rawText);
        this.reasoning.accumulatedReasoningText = split.reasoningText ?? rawText;
        await this.throttledCardUpdate();
    }
    async onPartialReply(payload) {
        if (!this.shouldProceed('onPartialReply'))
            return;
        // Use splitReasoningText (consistent with onDeliver/onReasoningStream)
        // to extract <think> tag content before stripping it from the answer.
        // Previously only stripReasoningTags was called, silently discarding
        // any thinking content that the LLM wrapped in <think> tags.
        const rawText = payload.text ?? '';
        const split = (0, builder_1.splitReasoningText)(rawText);
        if (split.reasoningText) {
            if (!this.reasoning.reasoningStartTime) {
                this.reasoning.reasoningStartTime = Date.now();
            }
            this.reasoning.accumulatedReasoningText = split.reasoningText;
            this.reasoning.isReasoningPhase = true;
        }
        const text = split.answerText ?? (0, builder_1.stripReasoningTags)(rawText);
        log.debug('onPartialReply', { len: text.length });
        if (!text)
            return;
        if (!this.reasoning.reasoningStartTime) {
            this.reasoning.reasoningStartTime = Date.now();
        }
        if (this.reasoning.isReasoningPhase) {
            this.reasoning.isReasoningPhase = false;
            this.reasoning.reasoningElapsedMs = this.reasoning.reasoningStartTime
                ? Date.now() - this.reasoning.reasoningStartTime
                : 0;
        }
        // 检测回复边界：文本长度缩短 → 新回复开始
        if (this.text.lastPartialText && text.length < this.text.lastPartialText.length) {
            this.text.streamingPrefix += (this.text.streamingPrefix ? '\n\n' : '') + this.text.lastPartialText;
        }
        this.text.lastPartialText = text;
        this.text.accumulatedText = this.text.streamingPrefix ? this.text.streamingPrefix + '\n\n' + text : text;
        // NO_REPLY 缓冲
        if (!this.text.streamingPrefix && reply_runtime_1.SILENT_REPLY_TOKEN.startsWith(this.text.accumulatedText.trim())) {
            log.debug('onPartialReply: buffering NO_REPLY prefix');
            return;
        }
        await this.ensureCardCreated();
        if (!this.shouldProceed('onPartialReply.postCreate'))
            return;
        if (!this.cardKit.cardMessageId)
            return;
        await this.throttledCardUpdate();
    }
    async onError(err, info) {
        if (this.guard.terminate('onError', err))
            return;
        log.error(`${info.kind} reply failed`, { error: String(err) });
        this.finalizeCard('onError', 'error');
        await this.flush.waitForFlush();
        if (this.cardCreationPromise)
            await this.cardCreationPromise;
        const errorEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
        const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;
        if (this.cardKit.cardMessageId) {
            try {
                const rawErrorText = this.text.accumulatedText
                    ? `${this.text.accumulatedText}\n\n---\n**Error**: An error occurred while generating the response.`
                    : '**Error**: An error occurred while generating the response.';
                const terminalContent = prepareTerminalCardContent({
                    text: rawErrorText,
                    reasoningText: this.reasoning.accumulatedReasoningText || undefined,
                }, this.imageResolver);
                const errorCard = (0, builder_1.buildCardContent)('complete', {
                    text: terminalContent.text,
                    reasoningText: terminalContent.reasoningText,
                    reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
                    elapsedMs: this.elapsed(),
                    isError: true,
                    footer: this.deps.resolvedFooter,
                    footerMetrics,
                });
                if (errorEffectiveCardId) {
                    await this.closeStreamingAndUpdate(errorEffectiveCardId, errorCard, 'onError');
                }
                else {
                    await (0, send_1.updateCardFeishu)({
                        cfg: this.deps.cfg,
                        messageId: this.cardKit.cardMessageId,
                        card: errorCard,
                        accountId: this.deps.accountId,
                    });
                }
            }
            catch {
                // Ignore update failures during error handling
            }
        }
    }
    async onIdle() {
        if (this.guard.isTerminated || this.guard.shouldSkip('onIdle'))
            return;
        if (!this.dispatchFullyComplete)
            return;
        if (this.isTerminalPhase)
            return;
        this.finalizeCard('onIdle', 'normal');
        await this.flush.waitForFlush();
        if (this.cardCreationPromise) {
            await this.cardCreationPromise;
            await new Promise((resolve) => setTimeout(resolve, 0));
            await this.flush.waitForFlush();
        }
        const idleEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
        if (this.cardKit.cardMessageId) {
            try {
                if (idleEffectiveCardId) {
                    const seqBeforeClose = this.cardKit.cardKitSequence;
                    this.cardKit.cardKitSequence += 1;
                    log.info('onIdle: closing streaming mode', {
                        seqBefore: seqBeforeClose,
                        seqAfter: this.cardKit.cardKitSequence,
                    });
                    await (0, cardkit_1.setCardStreamingMode)({
                        cfg: this.deps.cfg,
                        cardId: idleEffectiveCardId,
                        streamingMode: false,
                        sequence: this.cardKit.cardKitSequence,
                        accountId: this.deps.accountId,
                    });
                }
                const isNoReplyLeak = !this.text.completedText && reply_runtime_1.SILENT_REPLY_TOKEN.startsWith(this.text.accumulatedText.trim());
                const displayText = this.text.completedText || (isNoReplyLeak ? '' : this.text.accumulatedText) || reply_dispatcher_types_1.EMPTY_REPLY_FALLBACK_TEXT;
                if (!this.text.completedText && !this.text.accumulatedText) {
                    log.warn('reply completed without visible text, using empty-reply fallback');
                }
                // 等待图片异步解析（最多 15s），避免终态卡片留占位符
                const resolvedDisplayText = await this.imageResolver.resolveImagesAwait(displayText, 15_000);
                const terminalContent = prepareTerminalCardContent({
                    text: resolvedDisplayText,
                    reasoningText: this.reasoning.accumulatedReasoningText || undefined,
                }, this.imageResolver);
                const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;
                const completeCard = (0, builder_1.buildCardContent)('complete', {
                    text: terminalContent.text,
                    reasoningText: terminalContent.reasoningText,
                    reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
                    elapsedMs: this.elapsed(),
                    footer: this.deps.resolvedFooter,
                    footerMetrics,
                });
                if (idleEffectiveCardId) {
                    const seqBeforeUpdate = this.cardKit.cardKitSequence;
                    this.cardKit.cardKitSequence += 1;
                    log.info('onIdle: updating final card', {
                        seqBefore: seqBeforeUpdate,
                        seqAfter: this.cardKit.cardKitSequence,
                    });
                    await (0, cardkit_1.updateCardKitCard)({
                        cfg: this.deps.cfg,
                        cardId: idleEffectiveCardId,
                        card: (0, builder_1.toCardKit2)(completeCard),
                        sequence: this.cardKit.cardKitSequence,
                        accountId: this.deps.accountId,
                    });
                }
                else {
                    await (0, send_1.updateCardFeishu)({
                        cfg: this.deps.cfg,
                        messageId: this.cardKit.cardMessageId,
                        card: completeCard,
                        accountId: this.deps.accountId,
                    });
                }
                log.info('reply completed, card finalized', {
                    elapsedMs: this.elapsed(),
                    isCardKit: !!idleEffectiveCardId,
                });
            }
            catch (err) {
                log.warn('final card update failed', { error: String(err) });
            }
        }
    }
    // ------------------------------------------------------------------
    // External control
    // ------------------------------------------------------------------
    markFullyComplete() {
        log.debug('markFullyComplete', {
            completedTextLen: this.text.completedText.length,
            accumulatedTextLen: this.text.accumulatedText.length,
        });
        this.dispatchFullyComplete = true;
    }
    async abortCard() {
        try {
            if (!this.transition('aborted', 'abortCard', 'abort'))
                return;
            // transition() already executed onEnterTerminalPhase (cancel + complete + dispose hook)
            // Only need to wait for any in-flight flush to finish
            await this.flush.waitForFlush();
            if (this.cardCreationPromise)
                await this.cardCreationPromise;
            const effectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
            const elapsedMs = Date.now() - this.dispatchStartTime;
            const terminalContent = prepareTerminalCardContent({
                text: this.text.accumulatedText || 'Aborted.',
                reasoningText: this.reasoning.accumulatedReasoningText || undefined,
            }, this.imageResolver);
            const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;
            if (effectiveCardId) {
                const abortCardContent = (0, builder_1.buildCardContent)('complete', {
                    text: terminalContent.text,
                    reasoningText: terminalContent.reasoningText,
                    reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
                    elapsedMs,
                    isAborted: true,
                    footer: this.deps.resolvedFooter,
                    footerMetrics,
                });
                await this.closeStreamingAndUpdate(effectiveCardId, abortCardContent, 'abortCard');
                log.info('abortCard completed', { effectiveCardId });
            }
            else if (this.cardKit.cardMessageId) {
                // IM fallback: 卡片不是通过 CardKit 发的，用 im.message.patch 更新
                const abortCard = (0, builder_1.buildCardContent)('complete', {
                    text: terminalContent.text,
                    reasoningText: terminalContent.reasoningText,
                    reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
                    elapsedMs,
                    isAborted: true,
                    footer: this.deps.resolvedFooter,
                    footerMetrics,
                });
                await (0, send_1.updateCardFeishu)({
                    cfg: this.deps.cfg,
                    messageId: this.cardKit.cardMessageId,
                    card: abortCard,
                    accountId: this.deps.accountId,
                });
                log.info('abortCard completed (IM fallback)', {
                    messageId: this.cardKit.cardMessageId,
                });
            }
        }
        catch (err) {
            log.warn('abortCard failed', { error: String(err) });
        }
    }
    // ------------------------------------------------------------------
    // Internal: card creation
    // ------------------------------------------------------------------
    async ensureCardCreated() {
        if (this.guard.shouldSkip('ensureCardCreated.precheck'))
            return;
        if (this.cardKit.cardMessageId || this.phase === 'creation_failed' || this.isTerminalPhase) {
            return;
        }
        if (this.cardCreationPromise) {
            await this.cardCreationPromise;
            return;
        }
        if (!this.transition('creating', 'ensureCardCreated'))
            return;
        this.createEpoch += 1;
        const epoch = this.createEpoch;
        this.cardCreationPromise = (async () => {
            try {
                try {
                    // Step 1: Create card entity
                    const cId = await (0, cardkit_1.createCardEntity)({
                        cfg: this.deps.cfg,
                        card: STREAMING_THINKING_CARD,
                        accountId: this.deps.accountId,
                    });
                    if (this.isStaleCreate(epoch)) {
                        log.info('ensureCardCreated: stale epoch after createCardEntity, bailing out', {
                            epoch,
                            phase: this.phase,
                        });
                        return;
                    }
                    if (cId) {
                        this.cardKit.cardKitCardId = cId;
                        this.cardKit.originalCardKitCardId = cId;
                        this.cardKit.cardKitSequence = 1;
                        this.disposeShutdownHook = (0, shutdown_hooks_1.registerShutdownHook)(`streaming-card:${cId}`, () => this.abortCard());
                        log.info('created CardKit entity', {
                            cardId: cId,
                            initialSequence: this.cardKit.cardKitSequence,
                        });
                        // Step 2: Send IM message referencing card_id
                        const result = await (0, cardkit_1.sendCardByCardId)({
                            cfg: this.deps.cfg,
                            to: this.deps.chatId,
                            cardId: cId,
                            replyToMessageId: this.deps.replyToMessageId,
                            replyInThread: this.deps.replyInThread,
                            accountId: this.deps.accountId,
                        });
                        if (this.isStaleCreate(epoch)) {
                            log.info('ensureCardCreated: stale epoch after sendCardByCardId, bailing out', {
                                epoch,
                                phase: this.phase,
                            });
                            this.disposeShutdownHook?.();
                            this.disposeShutdownHook = null;
                            return;
                        }
                        this.cardKit.cardMessageId = result.messageId;
                        this.flush.setCardMessageReady(true);
                        if (!this.transition('streaming', 'ensureCardCreated.cardkit')) {
                            this.disposeShutdownHook?.();
                            this.disposeShutdownHook = null;
                            return;
                        }
                        log.info('sent CardKit card', { messageId: result.messageId });
                    }
                    else {
                        throw new Error('card.create returned empty card_id');
                    }
                }
                catch (cardKitErr) {
                    if (this.isStaleCreate(epoch))
                        return;
                    if (this.guard.terminate('ensureCardCreated.cardkitFlow', cardKitErr)) {
                        return;
                    }
                    // CardKit flow failed — fall back to regular IM card
                    const apiDetail = extractApiDetail(cardKitErr);
                    log.warn('CardKit flow failed, falling back to IM', { apiDetail });
                    this.cardKit.cardKitCardId = null;
                    this.cardKit.originalCardKitCardId = null;
                    const fallbackCard = (0, builder_1.buildCardContent)('thinking');
                    const result = await (0, send_1.sendCardFeishu)({
                        cfg: this.deps.cfg,
                        to: this.deps.chatId,
                        card: fallbackCard,
                        replyToMessageId: this.deps.replyToMessageId,
                        replyInThread: this.deps.replyInThread,
                        accountId: this.deps.accountId,
                    });
                    if (this.isStaleCreate(epoch)) {
                        log.info('ensureCardCreated: stale epoch after IM fallback send, bailing out', {
                            epoch,
                            phase: this.phase,
                        });
                        return;
                    }
                    this.cardKit.cardMessageId = result.messageId;
                    this.flush.setCardMessageReady(true);
                    if (!this.transition('streaming', 'ensureCardCreated.imFallback')) {
                        return;
                    }
                    log.info('sent fallback IM card', { messageId: result.messageId });
                }
            }
            catch (err) {
                if (this.isStaleCreate(epoch))
                    return;
                if (this.guard.terminate('ensureCardCreated.outer', err)) {
                    return;
                }
                log.warn('thinking card failed, falling back to static', {
                    error: String(err),
                });
                this.transition('creation_failed', 'ensureCardCreated.outer', 'creation_failed');
            }
        })();
        await this.cardCreationPromise;
    }
    // ------------------------------------------------------------------
    // Internal: flush
    // ------------------------------------------------------------------
    async performFlush() {
        if (!this.cardKit.cardMessageId || this.isTerminalPhase)
            return;
        // v2 CardKit 卡片不能走 IM patch，如果流式 CardKit 已禁用但 originalCardKitCardId
        // 仍在，说明卡片是通过 CardKit 发的——跳过中间态更新，等终态用 originalCardKitCardId 收尾
        if (!this.cardKit.cardKitCardId && this.cardKit.originalCardKitCardId) {
            log.debug('performFlush: skipping (CardKit streaming disabled, awaiting final update)');
            return;
        }
        log.debug('flushCardUpdate: enter', {
            seq: this.cardKit.cardKitSequence,
            isCardKit: !!this.cardKit.cardKitCardId,
        });
        try {
            const displayText = this.buildDisplayText();
            // 流式中间帧使用同步 resolveImages（不等待异步上传）
            const resolvedText = this.imageResolver.resolveImages(displayText);
            if (this.cardKit.cardKitCardId) {
                // CardKit streaming — typewriter effect
                const prevSeq = this.cardKit.cardKitSequence;
                this.cardKit.cardKitSequence += 1;
                log.debug('flushCardUpdate: seq bump', {
                    seqBefore: prevSeq,
                    seqAfter: this.cardKit.cardKitSequence,
                });
                await (0, cardkit_1.streamCardContent)({
                    cfg: this.deps.cfg,
                    cardId: this.cardKit.cardKitCardId,
                    elementId: builder_1.STREAMING_ELEMENT_ID,
                    content: (0, markdown_style_1.optimizeMarkdownStyle)(resolvedText),
                    sequence: this.cardKit.cardKitSequence,
                    accountId: this.deps.accountId,
                });
            }
            else {
                log.debug('flushCardUpdate: IM patch fallback');
                const card = (0, builder_1.buildCardContent)('streaming', {
                    text: this.reasoning.isReasoningPhase ? '' : resolvedText,
                    reasoningText: this.reasoning.isReasoningPhase ? this.reasoning.accumulatedReasoningText : undefined,
                });
                await (0, send_1.updateCardFeishu)({
                    cfg: this.deps.cfg,
                    messageId: this.cardKit.cardMessageId,
                    card: card,
                    accountId: this.deps.accountId,
                });
            }
        }
        catch (err) {
            if (this.guard.terminate('flushCardUpdate', err))
                return;
            const apiCode = (0, api_error_1.extractLarkApiCode)(err);
            // 速率限制（230020）— 跳过此帧，不降级
            if ((0, card_error_1.isCardRateLimitError)(err)) {
                log.info('flushCardUpdate: rate limited (230020), skipping', {
                    seq: this.cardKit.cardKitSequence,
                });
                return;
            }
            // 卡片表格数超出飞书限制（230099/11310）— 禁用 CardKit 流式，
            // 保留 originalCardKitCardId 供 onIdle 做最终 CardKit 更新
            if ((0, card_error_1.isCardTableLimitError)(err)) {
                log.warn('flushCardUpdate: card table limit exceeded (230099/11310), disabling CardKit streaming', {
                    seq: this.cardKit.cardKitSequence,
                });
                this.cardKit.cardKitCardId = null;
                return;
            }
            const apiDetail = extractApiDetail(err);
            log.error('card stream update failed', {
                apiCode,
                seq: this.cardKit.cardKitSequence,
                apiDetail,
            });
            if (this.cardKit.cardKitCardId) {
                log.warn('disabling CardKit streaming, falling back to im.message.patch');
                this.cardKit.cardKitCardId = null;
            }
        }
    }
    buildDisplayText() {
        if (this.reasoning.isReasoningPhase && this.reasoning.accumulatedReasoningText) {
            const reasoningDisplay = `💭 **Thinking...**\n\n${this.reasoning.accumulatedReasoningText}`;
            return this.text.accumulatedText ? this.text.accumulatedText + '\n\n' + reasoningDisplay : reasoningDisplay;
        }
        return this.text.accumulatedText;
    }
    async throttledCardUpdate() {
        if (this.guard.shouldSkip('throttledCardUpdate'))
            return;
        const throttleMs = this.cardKit.cardKitCardId ? reply_dispatcher_types_1.THROTTLE_CONSTANTS.CARDKIT_MS : reply_dispatcher_types_1.THROTTLE_CONSTANTS.PATCH_MS;
        await this.flush.throttledUpdate(throttleMs);
    }
    // ------------------------------------------------------------------
    // Internal: lifecycle helpers
    // ------------------------------------------------------------------
    finalizeCard(source, reason) {
        this.transition('completed', source, reason);
    }
    /**
     * Close streaming mode then update card content (shared by onError and abortCard).
     */
    async closeStreamingAndUpdate(cardId, card, label) {
        const seqBeforeClose = this.cardKit.cardKitSequence;
        this.cardKit.cardKitSequence += 1;
        log.info(`${label}: closing streaming mode`, {
            seqBefore: seqBeforeClose,
            seqAfter: this.cardKit.cardKitSequence,
        });
        await (0, cardkit_1.setCardStreamingMode)({
            cfg: this.deps.cfg,
            cardId,
            streamingMode: false,
            sequence: this.cardKit.cardKitSequence,
            accountId: this.deps.accountId,
        });
        const seqBeforeUpdate = this.cardKit.cardKitSequence;
        this.cardKit.cardKitSequence += 1;
        log.info(`${label}: updating card`, {
            seqBefore: seqBeforeUpdate,
            seqAfter: this.cardKit.cardKitSequence,
        });
        await (0, cardkit_1.updateCardKitCard)({
            cfg: this.deps.cfg,
            cardId,
            card: (0, builder_1.toCardKit2)(card),
            sequence: this.cardKit.cardKitSequence,
            accountId: this.deps.accountId,
        });
    }
}
exports.StreamingCardController = StreamingCardController;
// ---------------------------------------------------------------------------
// Error detail extraction helpers (replacing `any` casts)
// ---------------------------------------------------------------------------
/**
 * 终态卡片的正文和 reasoning 都会被飞书按 markdown 渲染，
 * 因此两者都要先做图片替换与表格降级，避免再次撞到 230099/11310。
 */
function prepareTerminalCardContent(content, imageResolver, tableLimit = card_error_1.FEISHU_CARD_TABLE_LIMIT) {
    const resolvedReasoningText = content.reasoningText ? imageResolver.resolveImages(content.reasoningText) : undefined;
    const resolvedText = imageResolver.resolveImages(content.text);
    const sanitizedSegments = (0, card_error_1.sanitizeTextSegmentsForCard)(resolvedReasoningText ? [resolvedReasoningText, resolvedText] : [resolvedText], tableLimit);
    if (resolvedReasoningText) {
        return {
            reasoningText: sanitizedSegments[0],
            text: sanitizedSegments[1],
        };
    }
    return { text: sanitizedSegments[0] };
}
function extractApiDetail(err) {
    if (!err || typeof err !== 'object')
        return String(err);
    const e = err;
    return e.response?.data ? JSON.stringify(e.response.data) : String(err);
}
