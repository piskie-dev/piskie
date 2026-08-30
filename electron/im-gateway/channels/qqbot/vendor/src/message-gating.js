/**
 * 群消息门控 — 统一入口。
 *
 * 将 ignoreOtherMentions / shouldBlock / mentionGating 三层判断收敛到
 * 一个纯函数 resolveGroupMessageGate() 中，让 gateway 主流程只关心一个结果。
 *
 * 按优先级串行检查：
 *   1. ignoreOtherMentions — @了其他人但未 @bot → 丢弃（记历史）
 *   2. shouldBlock         — 未授权控制命令静默拦截
 *   3. mentionGating       — requireMention 门控 + 命令旁路
 */
// ────────────────────── Core Logic ──────────────────────
/**
 * 基础 mention 门控纯函数。
 * effectiveWasMentioned = wasMentioned || implicitMention || shouldBypassMention
 * shouldSkip = requireMention && canDetectMention && !effectiveWasMentioned
 */
function resolveMentionGating(params) {
    const implicit = params.implicitMention === true;
    const bypass = params.shouldBypassMention === true;
    const effectiveWasMentioned = params.wasMentioned || implicit || bypass;
    const shouldSkip = params.requireMention && params.canDetectMention && !effectiveWasMentioned;
    return { effectiveWasMentioned, shouldSkip };
}
/**
 * 带命令旁路的 mention 门控。
 *
 * shouldBypassMention 条件（全部满足时才旁路）：
 * 1. requireMention    — 开启了 mention 要求
 * 2. !wasMentioned     — 没有被直接 mention
 * 3. !hasAnyMention    — 消息中没有任何 @（防止 @ 其他人的消息误 bypass）
 * 4. allowTextCommands — 文本命令已启用
 * 5. commandAuthorized — 发送者有命令权限
 * 6. hasControlCommand — 消息是合法控制命令
 */
function resolveMentionGatingWithBypass(params) {
    const shouldBypassMention = params.requireMention &&
        !params.wasMentioned &&
        !(params.hasAnyMention ?? false) &&
        params.allowTextCommands &&
        params.commandAuthorized &&
        params.hasControlCommand;
    return {
        ...resolveMentionGating({
            requireMention: params.requireMention,
            canDetectMention: params.canDetectMention,
            wasMentioned: params.wasMentioned,
            implicitMention: params.implicitMention,
            shouldBypassMention,
        }),
        shouldBypassMention,
    };
}
// ────────────────────── Unified Gate ──────────────────────
/**
 * 群消息统一门控，按优先级串行判定：
 *
 *   1. ignoreOtherMentions — @了其他人但未 @bot → drop_other_mention
 *   2. shouldBlock         — 未授权控制命令      → block_unauthorized_command
 *   3. mentionGating       — 未满足 @bot 条件    → skip_no_mention
 *   4. 通过所有检查                              → pass
 */
export function resolveGroupMessageGate(params) {
    const { ignoreOtherMentions, hasAnyMention, wasMentioned, implicitMention, allowTextCommands, isControlCommand, commandAuthorized, requireMention, canDetectMention, } = params;
    // ── Layer 1: ignoreOtherMentions ──
    if (ignoreOtherMentions &&
        hasAnyMention &&
        !wasMentioned &&
        !implicitMention) {
        return {
            action: "drop_other_mention",
            effectiveWasMentioned: false,
            shouldBypassMention: false,
        };
    }
    // ── Layer 2: shouldBlock 未授权控制命令 ──
    if (allowTextCommands && isControlCommand && !commandAuthorized) {
        return {
            action: "block_unauthorized_command",
            effectiveWasMentioned: false,
            shouldBypassMention: false,
        };
    }
    // ── Layer 3: mention 门控 + 命令旁路 ──
    const mentionGate = resolveMentionGatingWithBypass({
        requireMention,
        canDetectMention,
        wasMentioned,
        implicitMention,
        hasAnyMention,
        allowTextCommands,
        hasControlCommand: isControlCommand,
        commandAuthorized,
    });
    if (mentionGate.shouldSkip) {
        return {
            action: "skip_no_mention",
            effectiveWasMentioned: mentionGate.effectiveWasMentioned,
            shouldBypassMention: mentionGate.shouldBypassMention,
        };
    }
    return {
        action: "pass",
        effectiveWasMentioned: mentionGate.effectiveWasMentioned,
        shouldBypassMention: mentionGate.shouldBypassMention,
    };
}
