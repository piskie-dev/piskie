/**
 * QQBot Approval Handler
 *
 * 监听 Gateway 的 exec/plugin approval 事件，
 * 直接调用 QQ API 发送带 Inline Keyboard 的审批消息。
 * 参考 DiscordExecApprovalHandler 的实现模式。
 *
 * 兼容性：gateway-runtime / approval-runtime 模块在 openclaw < 3.22 上不存在，
 * 使用动态 import 避免插件整体加载失败，旧版框架上审批功能自动降级（不可用）。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAccessToken, sendC2CMessageWithInlineKeyboard, sendGroupMessageWithInlineKeyboard, } from "./api.js";
// ─── 动态加载 gateway-runtime（兼容不同安装环境） ────────
function loadGatewayRuntime() {
    const req = createRequire(import.meta.url);
    const currentFile = fileURLToPath(import.meta.url);
    const pluginRoot = path.resolve(path.dirname(currentFile), "..", "..");
    const fs = req("node:fs");
    // 尝试从找到的 openclaw 根目录加载 gateway-runtime.js
    const tryLoadFromRoot = (root) => {
        for (const rel of ["dist/plugin-sdk/gateway-runtime.js", "plugin-sdk/gateway-runtime.js"]) {
            const p = path.join(root, rel);
            try {
                if (fs.existsSync(p))
                    return req(p);
            }
            catch { /* try next */ }
        }
        return null;
    };
    // 策略 1: link-sdk-core.cjs findOpenclawRoot
    try {
        const { findOpenclawRoot } = req(path.join(pluginRoot, "scripts", "link-sdk-core.cjs"));
        const root = findOpenclawRoot(pluginRoot);
        if (root) {
            const mod = tryLoadFromRoot(root);
            if (mod)
                return mod;
        }
    }
    catch { /* fallback */ }
    // 策略 2: process.argv[1] 反推（当前进程就是 openclaw）
    try {
        const entry = process.argv[1];
        if (entry) {
            const realEntry = fs.realpathSync(entry);
            let dir = path.dirname(realEntry);
            for (let i = 0; i < 6; i++) {
                const mod = tryLoadFromRoot(dir);
                if (mod)
                    return mod;
                const parent = path.dirname(dir);
                if (parent === dir)
                    break;
                dir = parent;
            }
        }
    }
    catch { /* fallback */ }
    throw new Error("Cannot find openclaw/plugin-sdk/gateway-runtime (all strategies failed)");
}
// ─── 辅助函数 ───────────────────────────────────────────────
function toShortId(approvalId) {
    return approvalId.replace(/^(exec|plugin):/, "").slice(0, 8);
}
function resolveApprovalKind(approvalId) {
    return approvalId.startsWith("plugin:") ? "plugin" : "exec";
}
function buildExecApprovalText(request) {
    const expiresIn = Math.max(0, Math.round((request.expiresAtMs - Date.now()) / 1000));
    const lines = ["🔐 命令执行审批", ""];
    const cmd = request.request.commandPreview ?? request.request.command ?? "";
    if (cmd)
        lines.push(`\`\`\`\n${cmd.slice(0, 300)}\n\`\`\``);
    if (request.request.cwd)
        lines.push(`📁 目录: ${request.request.cwd}`);
    if (request.request.agentId)
        lines.push(`🤖 Agent: ${request.request.agentId}`);
    lines.push("", `⏱️ 超时: ${expiresIn} 秒`);
    return lines.join("\n");
}
function buildPluginApprovalText(request) {
    const timeoutSec = Math.round((request.request.timeoutMs ?? 120_000) / 1000);
    const severityIcon = request.request.severity === "critical" ? "🔴"
        : request.request.severity === "info" ? "🔵"
            : "🟡";
    const lines = [`${severityIcon} 审批请求`, ""];
    lines.push(`📋 ${request.request.title}`);
    if (request.request.description)
        lines.push(`📝 ${request.request.description}`);
    if (request.request.toolName)
        lines.push(`🔧 工具: ${request.request.toolName}`);
    if (request.request.pluginId)
        lines.push(`🔌 插件: ${request.request.pluginId}`);
    if (request.request.agentId)
        lines.push(`🤖 Agent: ${request.request.agentId}`);
    lines.push("", `⏱️ 超时: ${timeoutSec} 秒`);
    return lines.join("\n");
}
/**
 * Inline Keyboard（内嵌回调型按钮）
 * type=1(Callback)：点击触发 INTERACTION_CREATE，button_data = data 字段
 * group_id 相同 → 点一个后其余变灰（三选一语义）
 * click_limit=1 → 每人只能点一次
 * permission.type=2 → 所有人可操作
 */
function buildApprovalKeyboard(approvalId) {
    const makeBtn = (id, label, visitedLabel, data, style) => ({
        id,
        render_data: { label, visited_label: visitedLabel, style },
        action: {
            type: 1,
            data,
            permission: { type: 2 },
            click_limit: 1,
        },
        group_id: "approval",
    });
    return {
        content: {
            rows: [
                {
                    buttons: [
                        makeBtn("allow", "✅ 允许一次", "已允许", `approve:${approvalId}:allow-once`, 1),
                        makeBtn("always", "⭐ 始终允许", "已始终允许", `approve:${approvalId}:allow-always`, 1),
                        makeBtn("deny", "❌ 拒绝", "已拒绝", `approve:${approvalId}:deny`, 0),
                    ],
                },
            ],
        },
    };
}
/** 从 sessionKey 或 turnSourceTo 提取投递目标 */
function resolveTarget(sessionKey, turnSourceTo) {
    // 优先从 sessionKey 解析（如 agent:main:qqbot:direct:OPENID）
    const sk = sessionKey ?? turnSourceTo;
    if (!sk)
        return null;
    const m = sk.match(/qqbot:(c2c|direct|group):([A-F0-9]+)/i);
    if (!m)
        return null;
    const type = m[1].toLowerCase() === "group" ? "group" : "c2c";
    return { type, id: m[2] };
}
// ─── Handler 类 ──────────────────────────────────────────────
export class QQBotApprovalHandler {
    gatewayClient = null;
    pending = new Map();
    requestCache = new Map();
    opts;
    started = false;
    constructor(opts) {
        this.opts = opts;
    }
    async start() {
        if (this.started)
            return;
        this.started = true;
        const { log } = this.opts;
        log?.info(`[qqbot:${this.opts.accountId}] approval-handler: starting`);
        // 动态加载 gateway-runtime，兼容旧版框架的模块布局。
        let gatewayRuntime;
        try {
            gatewayRuntime = loadGatewayRuntime();
        }
        catch (err) {
            log?.error(`[qqbot:${this.opts.accountId}] approval-handler: gateway-runtime module not available, approval feature disabled. Error: ${err}`);
            this.started = false;
            return;
        }
        try {
            this.gatewayClient = await gatewayRuntime.createOperatorApprovalsGatewayClient({
                config: this.opts.cfg,
                gatewayUrl: this.opts.gatewayUrl,
                clientDisplayName: "QQBot Approval Handler",
                onEvent: (evt) => this.handleGatewayEvent(evt),
                onHelloOk: () => log?.info(`[qqbot:${this.opts.accountId}] approval-handler: connected to gateway`),
                onConnectError: (err) => log?.error(`[qqbot:${this.opts.accountId}] approval-handler: connect error: ${err.message}`),
                onClose: (code, reason) => log?.debug?.(`[qqbot:${this.opts.accountId}] approval-handler: gateway closed: ${code} ${reason}`),
            });
            this.gatewayClient.start();
            setApprovalFeatureAvailable(true);
        }
        catch (err) {
            log?.error(`[qqbot:${this.opts.accountId}] approval-handler: failed to create gateway client: ${err}`);
            this.started = false;
        }
    }
    async stop() {
        if (!this.started)
            return;
        this.started = false;
        for (const entry of this.pending.values())
            clearTimeout(entry.timeoutId);
        this.pending.clear();
        this.requestCache.clear();
        this.gatewayClient?.stop();
        this.gatewayClient = null;
        this.opts.log?.info(`[qqbot:${this.opts.accountId}] approval-handler: stopped`);
    }
    /** 检查是否有指定 shortId 对应的 pending 审批 */
    hasShortId(shortId) {
        for (const id of this.pending.keys()) {
            if (toShortId(id) === shortId)
                return true;
        }
        return false;
    }
    /** 解析审批请求（供 Interaction 回调或 /approve 命令调用） */
    async resolveApproval(approvalId, decision) {
        if (!this.gatewayClient)
            return false;
        // 查找完整 ID：支持完整 ID（exec:uuid / plugin:uuid）、纯 UUID、或 shortId（8位）
        let fullId = approvalId;
        if (this.pending.has(approvalId)) {
            fullId = approvalId;
        }
        else {
            // 尝试在 pending keys 中匹配：纯 UUID 可能对应 exec:uuid 或 plugin:uuid
            for (const id of this.pending.keys()) {
                if (id === approvalId) {
                    fullId = id;
                    break;
                }
                // 纯 UUID 匹配：pending key 的 uuid 部分等于传入值
                if (id.replace(/^(exec|plugin):/, "") === approvalId) {
                    fullId = id;
                    break;
                }
                // shortId 匹配
                if (toShortId(id) === approvalId) {
                    fullId = id;
                    break;
                }
            }
            // 也在 requestCache 中查找（handleResolved 可能已清除 pending）
            if (fullId === approvalId && !this.requestCache.has(approvalId)) {
                for (const id of this.requestCache.keys()) {
                    if (id.replace(/^(exec|plugin):/, "") === approvalId) {
                        fullId = id;
                        break;
                    }
                }
            }
        }
        const kind = resolveApprovalKind(fullId);
        const method = kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
        const isPending = this.pending.has(fullId);
        const isCached = this.requestCache.has(fullId);
        this.opts.log?.info(`[qqbot:${this.opts.accountId}] approval-handler: resolving ${fullId} (input=${approvalId}) kind=${kind} → ${decision}, pending=${isPending}, cached=${isCached}`);
        try {
            await this.gatewayClient.request(method, { id: fullId, decision });
            this.opts.log?.info(`[qqbot:${this.opts.accountId}] approval-handler: RPC success ${toShortId(fullId)} → ${decision} (method=${method})`);
            return true;
        }
        catch (err) {
            this.opts.log?.error(`[qqbot:${this.opts.accountId}] approval-handler: resolve failed: ${err}`);
            return false;
        }
    }
    handleGatewayEvent(evt) {
        if (evt.event === "exec.approval.requested") {
            void this.handleRequested(evt.payload, "exec");
        }
        else if (evt.event === "plugin.approval.requested") {
            void this.handleRequested(evt.payload, "plugin");
        }
        else if (evt.event === "exec.approval.resolved") {
            void this.handleResolved(evt.payload);
        }
        else if (evt.event === "plugin.approval.resolved") {
            void this.handleResolved(evt.payload);
        }
    }
    async handleRequested(request, kind) {
        const { log, appId, clientSecret, accountId } = this.opts;
        const shortId = toShortId(request.id);
        // 只处理本账号的请求
        const reqAccountId = request.request.turnSourceAccountId?.trim();
        if (reqAccountId && reqAccountId !== accountId)
            return;
        // 解析投递目标
        const sessionKey = request.request.sessionKey;
        const turnSourceTo = request.request.turnSourceTo;
        const target = resolveTarget(sessionKey, turnSourceTo);
        if (!target) {
            log?.info(`[qqbot:${accountId}] approval-handler: no QQ target for ${shortId} (session=${sessionKey})`);
            return;
        }
        // 缓存请求
        this.requestCache.set(request.id, kind === "plugin"
            ? { kind: "plugin", request: request }
            : { kind: "exec", request: request });
        log?.info(`[qqbot:${accountId}] approval-handler: sending ${kind} approval ${shortId} to ${target.type}:${target.id}`);
        const text = kind === "plugin"
            ? buildPluginApprovalText(request)
            : buildExecApprovalText(request);
        const keyboard = buildApprovalKeyboard(request.id);
        const timeoutMs = kind === "plugin"
            ? (request.request.timeoutMs ?? 120_000)
            : Math.max(0, request.expiresAtMs - Date.now());
        // 短暂延迟，确保框架侧 waitDecision 已就绪，避免时序竞争
        await new Promise((r) => setTimeout(r, 2000));
        try {
            const token = await getAccessToken(appId, clientSecret);
            if (target.type === "c2c") {
                await sendC2CMessageWithInlineKeyboard(token, target.id, text, keyboard);
            }
            else {
                await sendGroupMessageWithInlineKeyboard(token, target.id, text, keyboard);
            }
            log?.info(`[qqbot:${accountId}] approval-handler: sent ${kind} approval ${shortId}`);
            const timeoutId = setTimeout(() => {
                this.handleTimeout(request.id, target);
            }, timeoutMs + 2_000);
            this.pending.set(request.id, { targets: [target], timeoutId });
        }
        catch (err) {
            this.requestCache.delete(request.id);
            log?.error(`[qqbot:${accountId}] approval-handler: failed to send approval ${shortId}: ${err}`);
        }
    }
    async handleResolved(resolved) {
        const entry = this.pending.get(resolved.id);
        const resolvedBy = resolved.resolvedBy ?? "unknown";
        const kind = resolveApprovalKind(resolved.id);
        this.opts.log?.info(`[qqbot:${this.opts.accountId}] approval-handler: gateway confirmed ${toShortId(resolved.id)} → ${resolved.decision} (kind=${kind}, resolvedBy=${resolvedBy}, wasPending=${!!entry})`);
        if (!entry)
            return;
        clearTimeout(entry.timeoutId);
        this.pending.delete(resolved.id);
        this.requestCache.delete(resolved.id);
        // 框架 Forwarder 负责发送 resolved 通知（已通过 buildResolvedPayload=null 抑制），此处不重复发送
    }
    async handleTimeout(approvalId, target) {
        const { log, accountId } = this.opts;
        if (!this.pending.has(approvalId))
            return;
        this.pending.delete(approvalId);
        this.requestCache.delete(approvalId);
        log?.info(`[qqbot:${accountId}] approval-handler: timeout ${toShortId(approvalId)}`);
        // 超时由框架处理，此处仅清理状态，不重复发消息
    }
}
// ─── 模块级 handler 注册 ────────────────────────────────────
const _handlers = new Map();
/** 审批功能是否可用（gateway-runtime 模块加载成功则为 true） */
let _approvalFeatureAvailable = false;
export function isApprovalFeatureAvailable() {
    return _approvalFeatureAvailable;
}
export function setApprovalFeatureAvailable(available) {
    _approvalFeatureAvailable = available;
}
export function registerApprovalHandler(accountId, handler) {
    _handlers.set(accountId, handler);
}
export function unregisterApprovalHandler(accountId) {
    _handlers.delete(accountId);
}
export function getApprovalHandler(accountId) {
    return _handlers.get(accountId);
}
export function findApprovalHandlerForShortId(shortId) {
    for (const handler of _handlers.values()) {
        if (handler.hasShortId(shortId))
            return handler;
    }
    return undefined;
}
