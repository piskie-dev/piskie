// ── 消息队列默认配置 ──
const DEFAULT_GLOBAL_QUEUE_SIZE = 1000;
const DEFAULT_PER_PEER_QUEUE_SIZE = 20;
const DEFAULT_GROUP_QUEUE_SIZE = 50;
const DEFAULT_MAX_CONCURRENT_USERS = 10;
// ── 群消息合并工具函数 ──
/** 判断 peerId 是否属于群聊 */
const isGroupPeer = (peerId) => peerId.startsWith("group:") || peerId.startsWith("guild:");
/**
 * 将多条群消息合并为一条，用于群聊场景下排队消息的批量处理。
 * - content 拼接为多行，每行带发送者前缀
 * - 附件合并
 * - messageId / msgIdx / timestamp 取最后一条（用于回复引用）
 * - mentions 合并去重
 * - 如果有任意一条 @了你（is_you），合并结果也标记 @你
 * - senderIsBot 只要有一条不是 bot 就算非 bot
 */
function mergeGroupMessages(batch) {
    if (batch.length === 1)
        return batch[0];
    const last = batch[batch.length - 1];
    const first = batch[0];
    // 拼接内容：每条消息带发送者前缀
    const mergedContent = batch
        .map((m) => {
        const name = m.senderName ?? m.senderId;
        return `[${name}]: ${m.content}`;
    })
        .join("\n");
    // 合并附件
    const mergedAttachments = [];
    for (const m of batch) {
        if (m.attachments?.length) {
            mergedAttachments.push(...m.attachments);
        }
    }
    // 合并 mentions（去重 by member_openid/id）
    const seenMentionIds = new Set();
    const mergedMentions = [];
    let hasAtYouEvent = false;
    for (const m of batch) {
        if (m.eventType === "GROUP_AT_MESSAGE_CREATE") {
            hasAtYouEvent = true;
        }
        if (m.mentions) {
            for (const mt of m.mentions) {
                const key = mt.member_openid ?? mt.id ?? mt.user_openid ?? "";
                if (key && seenMentionIds.has(key))
                    continue;
                if (key)
                    seenMentionIds.add(key);
                mergedMentions.push(mt);
            }
        }
    }
    // senderIsBot: 只要有一条来自非 bot 用户，就算非 bot
    const allFromBot = batch.every((m) => m.senderIsBot);
    return {
        type: last.type,
        senderId: last.senderId,
        senderName: last.senderName,
        senderIsBot: allFromBot,
        content: mergedContent,
        messageId: last.messageId,
        timestamp: last.timestamp,
        channelId: last.channelId,
        guildId: last.guildId,
        groupOpenid: last.groupOpenid,
        attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
        refMsgIdx: first.refMsgIdx,
        msgIdx: last.msgIdx,
        eventType: hasAtYouEvent ? "GROUP_AT_MESSAGE_CREATE" : last.eventType,
        mentions: mergedMentions.length > 0 ? mergedMentions : undefined,
        messageScene: last.messageScene,
        _mergedCount: batch.length,
        _mergedMessages: batch.length > 1 ? batch : undefined,
    };
}
/**
 * 创建按用户并发的消息队列（同用户串行，跨用户并行）
 *
 * 内置群消息增强：
 * - 群聊 / 私聊使用不同队列上限
 * - 群聊溢出时优先丢弃 bot 消息
 * - drain 时自动合并群聊排队消息（斜杠命令单独处理）
 */
export function createMessageQueue(ctx) {
    const { accountId, log } = ctx;
    const globalQueueSize = ctx.globalQueueSize ?? DEFAULT_GLOBAL_QUEUE_SIZE;
    const peerQueueSize = ctx.peerQueueSize ?? DEFAULT_PER_PEER_QUEUE_SIZE;
    const groupQueueSize = ctx.groupQueueSize ?? DEFAULT_GROUP_QUEUE_SIZE;
    const maxConcurrentUsers = ctx.maxConcurrentUsers ?? DEFAULT_MAX_CONCURRENT_USERS;
    const userQueues = new Map();
    const activeUsers = new Set();
    let handleMessageFnRef = null;
    let totalEnqueued = 0;
    // PISKIE 本地改动（49号 §3.2.1）：fire-and-forget 的 drain/immediate 执行以
    // activeWork 集合追踪；stop 时 gateway 经 waitForIdle() 有界等待收尾，
    // 使渠道自有队列纳入 Connector settle barrier，停止语义不被绕过
    const activeWork = new Set();
    const track = (promise) => {
        activeWork.add(promise);
        promise.then(() => activeWork.delete(promise), () => activeWork.delete(promise));
        return promise;
    };
    const waitForIdle = async (timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (activeWork.size > 0) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                log?.error(`[qqbot:${accountId}] waitForIdle timeout: ${activeWork.size} in-flight task(s) not settled within ${timeoutMs}ms`);
                return false;
            }
            await Promise.race([
                Promise.allSettled([...activeWork]),
                new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 250))),
            ]);
        }
        return true;
    };
    const getMessagePeerId = (msg) => {
        if (msg.type === "guild")
            return `guild:${msg.channelId ?? "unknown"}`;
        if (msg.type === "group")
            return `group:${msg.groupOpenid ?? "unknown"}`;
        return `dm:${msg.senderId}`;
    };
    /** 从满队列中淘汰一条消息（群聊优先丢弃 bot 消息，否则丢弃最旧） */
    const evictOne = (queue, isGroup) => {
        if (isGroup) {
            const botIdx = queue.findIndex(m => m.senderIsBot);
            if (botIdx >= 0)
                return queue.splice(botIdx, 1)[0];
        }
        return queue.shift();
    };
    /** 判断消息是否为斜杠指令 */
    const isSlashCommand = (msg) => (msg.content ?? "").trim().startsWith("/");
    /** 处理单条消息，捕获异常并记录日志 */
    const processOne = async (msg, peerId, label) => {
        try {
            await handleMessageFnRef(msg);
            return true;
        }
        catch (err) {
            log?.error(`[qqbot:${accountId}] ${label} error for ${peerId}: ${err}`);
            return false;
        }
    };
    /** 批量处理群聊排队消息：斜杠指令逐条处理，普通消息合并后处理 */
    const drainGroupBatch = async (all, peerId) => {
        const commands = [];
        const normal = [];
        for (const m of all) {
            (isSlashCommand(m) ? commands : normal).push(m);
        }
        // 指令消息逐条处理
        for (const cmd of commands) {
            log?.info(`[qqbot:${accountId}] Processing command independently for ${peerId}: ${(cmd.content ?? "").trim().slice(0, 50)}`);
            await processOne(cmd, peerId, "Command processor");
        }
        // 普通消息合并后处理
        if (normal.length > 0) {
            const merged = mergeGroupMessages(normal);
            if (normal.length > 1) {
                log?.info(`[qqbot:${accountId}] Merged ${normal.length} queued group messages for ${peerId} into one`);
            }
            await processOne(merged, peerId, `Message processor (merged batch of ${normal.length})`);
        }
    };
    /** 处理指定 peer 队列中的消息（串行） */
    const drainUserQueue = async (peerId) => {
        if (activeUsers.has(peerId))
            return;
        if (activeUsers.size >= maxConcurrentUsers) {
            log?.info(`[qqbot:${accountId}] Max concurrent users (${maxConcurrentUsers}) reached, ${peerId} will wait`);
            return;
        }
        const queue = userQueues.get(peerId);
        if (!queue || queue.length === 0) {
            userQueues.delete(peerId);
            return;
        }
        activeUsers.add(peerId);
        const isGroup = isGroupPeer(peerId);
        try {
            while (queue.length > 0 && !ctx.isAborted()) {
                // 群聊排队 > 1 条：批量处理
                if (isGroup && queue.length > 1 && handleMessageFnRef) {
                    const all = queue.splice(0, queue.length);
                    totalEnqueued = Math.max(0, totalEnqueued - all.length);
                    await drainGroupBatch(all, peerId);
                    continue;
                }
                // 非群聊 或 队列只剩 1 条：逐条处理
                const msg = queue.shift();
                totalEnqueued = Math.max(0, totalEnqueued - 1);
                if (handleMessageFnRef) {
                    await processOne(msg, peerId, "Message processor");
                }
            }
        }
        finally {
            activeUsers.delete(peerId);
            userQueues.delete(peerId);
            // 尽量填满并发槽位（track: 纳入 settle barrier）
            for (const [waitingPeerId, waitingQueue] of userQueues) {
                if (activeUsers.size >= maxConcurrentUsers)
                    break;
                if (waitingQueue.length > 0 && !activeUsers.has(waitingPeerId)) {
                    track(drainUserQueue(waitingPeerId));
                }
            }
        }
    };
    const enqueue = (msg) => {
        // PISKIE 本地改动（49号 §3.2.1/§11.1.54）：abort 后不再接收新消息——
        // 停止中的账号不得把消息送进处理循环
        if (ctx.isAborted()) {
            log?.info(`[qqbot:${accountId}] Queue aborted, drop inbound message ${msg.messageId ?? "(no id)"}`);
            return;
        }
        const peerId = getMessagePeerId(msg);
        const isGroup = isGroupPeer(peerId);
        let queue = userQueues.get(peerId);
        if (!queue) {
            queue = [];
            userQueues.set(peerId, queue);
        }
        // 群聊和非群聊使用不同的队列上限
        const maxSize = isGroup ? groupQueueSize : peerQueueSize;
        // 队列溢出：淘汰一条旧消息
        if (queue.length >= maxSize) {
            const dropped = evictOne(queue, isGroup);
            totalEnqueued = Math.max(0, totalEnqueued - 1);
            if (isGroup && dropped?.senderIsBot) {
                log?.info(`[qqbot:${accountId}] Queue full for ${peerId}, dropping bot message ${dropped.messageId}`);
            }
            else {
                log?.error(`[qqbot:${accountId}] Queue full for ${peerId}, dropping oldest message ${dropped?.messageId}`);
            }
        }
        // 全局总量保护
        totalEnqueued++;
        if (totalEnqueued > globalQueueSize) {
            log?.error(`[qqbot:${accountId}] Global queue limit reached (${totalEnqueued}), message from ${peerId} may be delayed`);
        }
        queue.push(msg);
        log?.debug?.(`[qqbot:${accountId}] Message enqueued for ${peerId}, user queue: ${queue.length}, active users: ${activeUsers.size}`);
        // 如果该用户没有正在处理的消息，立即启动处理（track: 纳入 settle barrier）
        track(drainUserQueue(peerId));
    };
    const startProcessor = (handleMessageFn) => {
        handleMessageFnRef = handleMessageFn;
        log?.info(`[qqbot:${accountId}] Message processor started (per-user concurrency, max ${maxConcurrentUsers} users)`);
    };
    const getSnapshot = (senderPeerId) => {
        let totalPending = 0;
        for (const [, q] of userQueues) {
            totalPending += q.length;
        }
        const senderQueue = userQueues.get(senderPeerId);
        return {
            totalPending,
            activeUsers: activeUsers.size,
            maxConcurrentUsers,
            senderPending: senderQueue ? senderQueue.length : 0,
        };
    };
    const clearUserQueue = (peerId) => {
        const queue = userQueues.get(peerId);
        if (!queue || queue.length === 0)
            return 0;
        const droppedCount = queue.length;
        queue.length = 0;
        totalEnqueued = Math.max(0, totalEnqueued - droppedCount);
        return droppedCount;
    };
    const executeImmediate = (msg) => {
        if (handleMessageFnRef) {
            // PISKIE 本地改动（49号 §3.2.1）：track 纳入 settle barrier
            track(handleMessageFnRef(msg).catch(err => {
                log?.error(`[qqbot:${accountId}] Immediate execution error: ${err}`);
            }));
        }
    };
    return { enqueue, startProcessor, getSnapshot, getMessagePeerId, clearUserQueue, executeImmediate, waitForIdle };
}
