/**
 * QQBot 插件级斜杠指令处理器
 *
 * 设计原则：
 * 1. 在消息入队前拦截，匹配到插件级指令后直接回复，不进入 AI 处理队列
 * 2. 不匹配的 "/" 消息照常入队，交给 OpenClaw 框架处理
 * 3. 每个指令通过 SlashCommand 接口注册，易于扩展
 *
 * 时间线追踪：
 *   开平推送时间戳 → 插件收到(Date.now()) → 指令处理完成(Date.now())
 *   从而计算「开平→插件」和「插件处理」两段耗时
 */
/**
 * PISKIE 本地改动（存储隔离）：
 * - /bot-upgrade 的 OpenClaw 热更新分支整体移除（CLI 探测、凭据备份、配置改写、升级脚本、
 *   gateway restart 均是对外部 OpenClaw 安装的操作）；QQ 组件随 Piskie 一起更新。
 * - /bot-logs 不再扫描/导出外部 OpenClaw 日志目录；诊断走 Piskie 应用日志导出。
 * - /bot-clear-storage 清理目录改为 Piskie 注入的 QQ 媒体根。
 * - getFrameworkVersion() 不再执行外部 `openclaw --version`，改为读取宿主注入的 runtime 版本。
 */
import path from "node:path";
import fs from "node:fs";
import { getUpdateInfo } from "./update-checker.js";
import { resolveQQBotMediaDir } from "./utils/platform.js";
import { getPackageVersion } from "./utils/pkg-version.js";
import { getQQBotRuntime } from "./runtime.js";
import { isApprovalFeatureAvailable } from "./approval-handler.js";
let PLUGIN_VERSION = getPackageVersion(import.meta.url);
/** 宿主（Piskie）注入的 openclaw 形状 runtime 版本；未注入时返回 "unknown"。 */
export function getFrameworkVersion() {
    try {
        const version = getQQBotRuntime().version;
        return typeof version === "string" && version.trim() ? version.trim() : "unknown";
    }
    catch {
        return "unknown";
    }
}
/**
 * 解析框架版本字符串中的日期版本号
 * 输入示例: "OpenClaw 2026.3.13 (61d171a)" → "2026.3.13"
 */
export function parseFrameworkDateVersion(versionStr) {
    const m = versionStr.match(/(\d{4}\.\d{1,2}\.\d{1,2})/);
    return m ? m[1] : null;
}
// ============ 指令注册表 ============
const commands = new Map();
function registerCommand(cmd) {
    commands.set(cmd.name.toLowerCase(), cmd);
}
// ============ 内置指令 ============
/**
 * /bot-ping — 测试当前 openclaw 与 QQ 连接的网络延迟
 */
registerCommand({
    name: "bot-ping",
    description: "测试当前 openclaw 与 QQ 连接的网络延迟",
    usage: [
        `/bot-ping`,
        ``,
        `测试 OpenClaw 主机与 QQ 服务器之间的网络延迟。`,
        `返回网络传输耗时和插件处理耗时。`,
    ].join("\n"),
    handler: (ctx) => {
        const now = Date.now();
        const eventTime = new Date(ctx.eventTimestamp).getTime();
        if (isNaN(eventTime)) {
            return `✅ pong!`;
        }
        const totalMs = now - eventTime;
        const qqToPlugin = ctx.receivedAt - eventTime;
        const pluginProcess = now - ctx.receivedAt;
        const lines = [
            `✅ pong！`,
            ``,
            `⏱ 延迟: ${totalMs}ms`,
            `  ├ 网络传输: ${qqToPlugin}ms`,
            `  └ 插件处理: ${pluginProcess}ms`,
        ];
        return lines.join("\n");
    },
});
/**
 * /bot-version — 查看插件版本号
 */
registerCommand({
    name: "bot-version",
    description: "查看插件版本号",
    usage: [
        `/bot-version`,
        ``,
        `查看当前 QQBot 插件版本和 OpenClaw 框架版本。`,
        `同时检查是否有新版本可用。`,
    ].join("\n"),
    handler: async () => {
        const frameworkVersion = getFrameworkVersion();
        const lines = [
            `🦞框架版本：${frameworkVersion}`,
            `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
        ];
        const info = await getUpdateInfo();
        if (info.checkedAt === 0) {
            lines.push(`⏳ 版本检查中...`);
        }
        else if (info.error) {
            lines.push(`⚠️ 版本检查失败`);
        }
        else if (info.hasUpdate && info.latest) {
            lines.push(`🆕最新可用版本：v${info.latest}，点击 <qqbot-cmd-input text="/bot-upgrade" show="/bot-upgrade"/> 查看升级指引`);
        }
        lines.push(`🌟官方 GitHub 仓库：[点击前往](https://github.com/tencent-connect/openclaw-qqbot/)`);
        return lines.join("\n");
    },
});
/**
 * /bot-help — 查看所有指令以及用途
 */
registerCommand({
    name: "bot-help",
    description: "查看所有指令以及用途",
    usage: [
        `/bot-help`,
        ``,
        `列出所有可用的 QQBot 插件内置指令及其简要说明。`,
        `使用 /指令名 ? 可查看某条指令的详细用法。`,
    ].join("\n"),
    handler: (ctx) => {
        // 群聊场景排除仅限私聊的指令
        const GROUP_EXCLUDED_COMMANDS = new Set(["bot-upgrade", "bot-clear-storage"]);
        const isGroup = ctx.type === "group";
        const lines = [`### QQBot插件内置调试指令`, ``];
        for (const [name, cmd] of commands) {
            if (isGroup && GROUP_EXCLUDED_COMMANDS.has(name))
                continue;
            lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description}`);
        }
        lines.push(``, `> 插件版本 v${PLUGIN_VERSION}`);
        return lines.join("\n");
    },
});
/**
 * /bot-upgrade — PISKIE：QQ 组件随 Piskie 一起更新，不再提供 OpenClaw 热更新。
 */
registerCommand({
    name: "bot-upgrade",
    description: "查看 QQ 组件更新方式",
    usage: [
        `/bot-upgrade`,
        ``,
        `QQ 组件随 Piskie 更新，无需单独升级插件。`,
    ].join("\n"),
    handler: async () => {
        const lines = [
            `ℹ️ QQ 组件随 Piskie 更新`,
            ``,
            `当前 QQBot 组件版本：v${PLUGIN_VERSION}`,
            `请通过更新 Piskie 应用获取新版本，无需在此处执行升级。`,
        ];
        return lines.join("\n");
    },
});
/**
 * /bot-logs — PISKIE：不再扫描/导出外部 OpenClaw 日志目录。
 */
registerCommand({
    name: "bot-logs",
    description: "查看日志获取方式",
    usage: [
        `/bot-logs`,
        ``,
        `QQ 组件日志已并入 Piskie 应用日志，请在 Piskie 中导出应用日志用于诊断。`,
    ].join("\n"),
    handler: () => {
        return [
            `ℹ️ QQ 组件日志已并入 Piskie 应用日志`,
            ``,
            `请在 Piskie 应用中导出应用日志（logs/app）用于诊断，此处不再单独导出。`,
        ].join("\n");
    },
});
// ============ /bot-clear-storage ============
/**
 * 扫描指定目录下的所有文件，递归统计。
 * 返回按文件大小降序排列的文件列表。
 */
function scanDirectoryFiles(dirPath) {
    const files = [];
    if (!fs.existsSync(dirPath))
        return files;
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            }
            else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(fullPath);
                    files.push({ filePath: fullPath, size: stat.size });
                }
                catch {
                    // 跳过无法访问的文件
                }
            }
        }
    };
    walk(dirPath);
    // 按大小降序排列
    files.sort((a, b) => b.size - a.size);
    return files;
}
/** 格式化文件大小为人类可读形式 */
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
/**
 * /bot-clear-storage — 清理通过 QQBot 对话产生的文件以及下载的资源
 *
 * 仅在私聊（c2c）中可用。
 * --force 执行时删除整个 appId 目录下的所有文件（不区分用户 openid）。
 *
 * 产品流程：
 *   /bot-clear-storage          — 扫描并列出当前 appId 下的文件，展示确认按钮
 *   /bot-clear-storage --force   — 确认执行删除
 */
registerCommand({
    name: "bot-clear-storage",
    description: "清理通过QQBot对话产生的文件以及下载的资源（保存在 Piskie 运行主机上）",
    usage: [
        `/bot-clear-storage`,
        ``,
        `扫描当前机器人产生的下载文件并列出明细。`,
        `确认后执行删除，释放主机磁盘空间。`,
        ``,
        `/bot-clear-storage --force   确认执行清理`,
        ``,
        `⚠️ 仅在私聊中可用。`,
    ].join("\n"),
    handler: (ctx) => {
        const { appId, type } = ctx;
        // 仅私聊可用
        if (type !== "c2c") {
            return `💡 请在私聊中使用此指令`;
        }
        const isForce = ctx.args.trim() === "--force";
        // 删除粒度为 appId 目录（不区分用户 openid）
        // 路径: downloads/{appId}/
        // PISKIE：沿用注入的 QQ 媒体根 <userData>/im-gateway/qqbot/media/downloads/{appId}
        const targetDir = resolveQQBotMediaDir("downloads", appId);
        const displayDir = `im-gateway/qqbot/media/downloads/${appId}`;
        if (!isForce) {
            // ── 第一步：扫描并展示文件列表 ──
            const files = scanDirectoryFiles(targetDir);
            if (files.length === 0) {
                return [
                    `✅ 当前没有需要清理的文件`,
                    ``,
                    `目录 \`${displayDir}\` 为空或不存在。`,
                ].join("\n");
            }
            const totalSize = files.reduce((sum, f) => sum + f.size, 0);
            const MAX_DISPLAY = 10;
            const lines = [
                `即将清理 \`${displayDir}\` 目录下所有文件，总共 ${files.length} 个文件，占用磁盘存储空间 ${formatBytes(totalSize)}。`,
                ``,
                `目录文件概况：`,
            ];
            // 展示前 MAX_DISPLAY 个（按大小降序）
            const displayFiles = files.slice(0, MAX_DISPLAY);
            for (const f of displayFiles) {
                const relativePath = path.relative(targetDir, f.filePath);
                // 在 Windows 上统一用 / 分隔显示
                const displayName = relativePath.replace(/\\/g, "/");
                lines.push(`${displayName} (${formatBytes(f.size)})`, ``, ``);
            }
            if (files.length > MAX_DISPLAY) {
                lines.push(`...[合计：${files.length} 个文件（${formatBytes(totalSize)}）]`, ``);
            }
            lines.push(``, `---`, ``, `确认清理后，上述保存在 Piskie 运行主机磁盘上的文件将永久删除，后续对话过程中AI无法再找回相关文件。`, `‼️ 点击指令确认删除`, `<qqbot-cmd-enter text="/bot-clear-storage --force" />`);
            return lines.join("\n");
        }
        // ── 第二步：--force 执行删除 ──
        const files = scanDirectoryFiles(targetDir);
        if (files.length === 0) {
            return `✅ 目录已为空，无需清理`;
        }
        let deletedCount = 0;
        let deletedSize = 0;
        let failedCount = 0;
        for (const f of files) {
            try {
                fs.unlinkSync(f.filePath);
                deletedCount++;
                deletedSize += f.size;
            }
            catch {
                failedCount++;
            }
        }
        // 尝试清理空目录（递归删除空子目录）
        try {
            removeEmptyDirs(targetDir);
        }
        catch {
            // 非关键，静默忽略
        }
        if (failedCount === 0) {
            return [
                `✅ 清理成功`,
                ``,
                `已删除 ${deletedCount} 个文件，释放 ${formatBytes(deletedSize)} 磁盘空间。`,
            ].join("\n");
        }
        return [
            `⚠️ 部分清理完成`,
            ``,
            `已删除 ${deletedCount} 个文件（${formatBytes(deletedSize)}），${failedCount} 个文件删除失败。`,
        ].join("\n");
    },
});
/** 递归删除空目录（从叶子向上清理） */
function removeEmptyDirs(dirPath) {
    if (!fs.existsSync(dirPath))
        return;
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            removeEmptyDirs(path.join(dirPath, entry.name));
        }
    }
    // 重新读取，如果目录已空则删除
    try {
        const remaining = fs.readdirSync(dirPath);
        if (remaining.length === 0) {
            fs.rmdirSync(dirPath);
        }
    }
    catch {
        // 目录可能正在被使用，跳过
    }
}
// ============ /bot-streaming ============
/**
 * /bot-streaming on|off — 一键开关流式消息
 *
 * 直接修改当前账户的 streaming 配置项并持久化到 openclaw.json。
 * 修改后即时生效（下一条消息起按新配置处理）。
 */
registerCommand({
    name: "bot-streaming",
    description: "一键开关流式消息",
    usage: [
        `/bot-streaming on     开启流式消息`,
        `/bot-streaming off    关闭流式消息`,
        `/bot-streaming        查看当前流式消息状态`,
        ``,
        `开启后，AI 的回复会以流式形式逐步显示（打字机效果）。`,
        `注意：仅 C2C（私聊）支持流式消息。`,
    ].join("\n"),
    handler: async (ctx) => {
        // 流式消息仅支持 C2C（私聊），群/频道场景直接提示
        if (ctx.type !== "c2c") {
            return `❌ 流式消息仅支持私聊场景，请在私聊中使用 /bot-streaming 指令`;
        }
        const arg = ctx.args.trim().toLowerCase();
        // 读取当前 streaming 状态
        const currentStreaming = ctx.accountConfig?.streaming === true;
        // 无参数：查看当前状态
        if (!arg) {
            return [
                `📡 流式消息状态：${currentStreaming ? "✅ 已开启" : "❌ 已关闭"}`,
                ``,
                `使用 <qqbot-cmd-input text="/bot-streaming on" show="/bot-streaming on"/> 开启`,
                `使用 <qqbot-cmd-input text="/bot-streaming off" show="/bot-streaming off"/> 关闭`,
            ].join("\n");
        }
        if (arg !== "on" && arg !== "off") {
            return `❌ 参数错误，请使用 on 或 off\n\n示例：/bot-streaming on`;
        }
        const newStreaming = arg === "on";
        // 如果状态没变，直接返回
        if (newStreaming === currentStreaming) {
            return `📡 流式消息已经是${newStreaming ? "开启" : "关闭"}状态，无需操作`;
        }
        // 更新配置（参考 handleInteractionCreate 中的配置更新逻辑）
        try {
            const runtime = getQQBotRuntime();
            const configApi = runtime.config;
            const currentCfg = structuredClone(configApi.loadConfig());
            const qqbot = (currentCfg.channels ?? {}).qqbot;
            if (!qqbot) {
                return `❌ 配置文件中未找到 qqbot 通道配置`;
            }
            const accountId = ctx.accountId;
            const isNamedAccount = accountId !== "default" && qqbot.accounts?.[accountId];
            if (isNamedAccount) {
                // 命名账户：更新 accounts.{accountId}.streaming
                const accounts = qqbot.accounts;
                const acct = accounts[accountId] ?? {};
                acct.streaming = newStreaming;
                accounts[accountId] = acct;
                qqbot.accounts = accounts;
            }
            else {
                // 默认账户：更新 qqbot.streaming
                qqbot.streaming = newStreaming;
            }
            await configApi.writeConfigFile(currentCfg);
            return [
                `✅ 流式消息已${newStreaming ? "开启" : "关闭"}`,
                ``,
                newStreaming
                    ? `AI 的回复将以流式形式逐步显示（仅私聊生效）。`
                    : `AI 的回复将恢复为完整发送。`,
            ].join("\n");
        }
        catch (err) {
            const fwVer = getFrameworkVersion();
            return [
                `❌ 当前版本不支持该指令`,
                ``,
                `🦞框架版本：${fwVer}`,
                `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
                ``,
                `可通过以下命令手动开启流式消息：`,
                ``,
                `\`\`\`shell`,
                `# 1. 开启流式消息`,
                `openclaw config set channels.qqbot.streaming true`,
                ``,
                `# 2. 重启网关使配置生效`,
                `openclaw gateway restart`,
                `\`\`\``,
            ].join("\n");
        }
    },
});
// ============ /bot-approve 审批配置管理 ============
/**
 * /bot-approve — 管理命令执行审批配置
 *
 * 修改 openclaw.json 中 tools.exec.security / tools.exec.ask 字段。
 *
 * security: deny | allowlist | full
 * ask: off | on-miss | always
 */
registerCommand({
    name: "bot-approve",
    description: "管理命令执行审批配置",
    usage: [
        `/bot-approve            查看操作指引`,
        `/bot-approve on         开启审批（白名单模式，推荐）`,
        `/bot-approve off        关闭审批，命令直接执行`,
        `/bot-approve always     始终审批，每次执行都需审批`,
        `/bot-approve reset      恢复框架默认值`,
        `/bot-approve status     查看当前审批配置`,
    ].join("\n"),
    handler: async (ctx) => {
        const arg = ctx.args.trim().toLowerCase();
        // 审批功能需要 openclaw >= 3.22（gateway-runtime 模块）
        if (!isApprovalFeatureAvailable()) {
            return `❌ 当前 OpenClaw 版本不支持审批功能，请升级至最新版本后重试。`;
        }
        let runtime;
        try {
            runtime = getQQBotRuntime();
        }
        catch {
            // runtime 不可用，构造 prompt 委托给 AI 模型通过 CLI 完成
            const presetMap = {
                on: { security: "allowlist", ask: "on-miss", desc: "开启审批（白名单模式）" },
                off: { security: "full", ask: "off", desc: "关闭审批" },
                always: { security: "allowlist", ask: "always", desc: "严格模式（每次都审批）" },
                strict: { security: "allowlist", ask: "always", desc: "严格模式（每次都审批）" },
            };
            const preset = presetMap[arg];
            if (preset) {
                return {
                    delegatePrompt: [
                        `请帮我${preset.desc}。执行以下单条命令（不要拆开）：`,
                        `openclaw config set tools.exec.security ${preset.security} && openclaw config set tools.exec.ask ${preset.ask}`,
                        `执行完成后告诉用户审批配置已更新为 security=${preset.security}, ask=${preset.ask}。`,
                    ].join("\n"),
                };
            }
            if (arg === "reset") {
                return {
                    delegatePrompt: [
                        `请帮我重置审批配置。执行以下单条命令（不要拆开）：`,
                        `openclaw config unset tools.exec.security && openclaw config unset tools.exec.ask`,
                        `执行完成后告诉用户审批配置已重置为框架默认值。`,
                    ].join("\n"),
                };
            }
            if (arg === "status") {
                return {
                    delegatePrompt: [
                        `请帮我查看当前命令执行审批配置。执行以下单条命令（不要拆开）：`,
                        `echo "security=$(openclaw config get tools.exec.security)" && echo "ask=$(openclaw config get tools.exec.ask)"`,
                        `然后告诉用户当前 security 和 ask 的值，以及可用的操作选项：`,
                        `- /bot-approve on    开启审批（白名单模式）`,
                        `- /bot-approve off   关闭审批`,
                        `- /bot-approve always 严格模式`,
                        `- /bot-approve reset 恢复默认`,
                    ].join("\n"),
                };
            }
            // 无参数或未知参数：直接返回操作指引
            return [
                `🔐 命令执行审批配置`,
                ``,
                `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）`,
                `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
                `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
                `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
                `<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置`,
            ].join("\n");
        }
        const configApi = runtime.config;
        const loadExecConfig = () => {
            const cfg = configApi.loadConfig();
            const tools = (cfg.tools ?? {});
            const exec = (tools.exec ?? {});
            return {
                security: String(exec.security ?? "deny"),
                ask: String(exec.ask ?? "on-miss"),
            };
        };
        const writeExecConfig = async (security, ask) => {
            const cfg = structuredClone(configApi.loadConfig());
            const tools = (cfg.tools ?? {});
            const exec = (tools.exec ?? {});
            exec.security = security;
            exec.ask = ask;
            tools.exec = exec;
            cfg.tools = tools;
            await configApi.writeConfigFile(cfg);
        };
        const formatStatus = (security, ask) => {
            const secIcon = security === "full" ? "🟢" : security === "allowlist" ? "🟡" : "🔴";
            const askIcon = ask === "off" ? "🟢" : ask === "always" ? "🔴" : "🟡";
            return [
                `🔐 当前审批配置`,
                ``,
                `${secIcon} 安全模式 (security): **${security}**`,
                `${askIcon} 审批模式 (ask): **${ask}**`,
                ``,
                security === "deny" ? `⚠️ 当前为 deny 模式，所有命令执行被拒绝` :
                    security === "full" && ask === "off" ? `✅ 所有命令无需审批直接执行` :
                        security === "allowlist" && ask === "on-miss" ? `🛡️ 白名单命令直接执行，其余需审批` :
                            ask === "always" ? `🔒 每次命令执行都需要人工审批` :
                                `ℹ️ security=${security}, ask=${ask}`,
            ].join("\n");
        };
        // 无参数：操作指引
        if (!arg) {
            return [
                `🔐 命令执行审批配置`,
                ``,
                `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）`,
                `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
                `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
                `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
                `<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置`,
            ].join("\n");
        }
        // status: 查看当前配置
        if (arg === "status") {
            const { security, ask } = loadExecConfig();
            return [
                formatStatus(security, ask),
                ``,
                `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批`,
                `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
                `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
                `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
            ].join("\n");
        }
        // on: 开启审批（白名单 + 未命中审批）
        if (arg === "on") {
            try {
                await writeExecConfig("allowlist", "on-miss");
                return [
                    `✅ 审批已开启`,
                    ``,
                    `• security = allowlist（白名单模式）`,
                    `• ask = on-miss（未命中白名单时需审批）`,
                    ``,
                    `已批准的命令自动加入白名单，下次直接执行。`,
                ].join("\n");
            }
            catch (err) {
                return `❌ 配置更新失败: ${err}`;
            }
        }
        // off: 关闭审批
        if (arg === "off") {
            try {
                await writeExecConfig("full", "off");
                return [
                    `✅ 审批已关闭`,
                    ``,
                    `• security = full（允许所有命令）`,
                    `• ask = off（不需要审批）`,
                    ``,
                    `⚠️ 所有命令将直接执行，不会弹出审批确认。`,
                ].join("\n");
            }
            catch (err) {
                return `❌ 配置更新失败: ${err}`;
            }
        }
        // always: 始终审批（每次都审批）
        if (arg === "always") {
            try {
                await writeExecConfig("allowlist", "always");
                return [
                    `✅ 已切换为严格审批模式`,
                    ``,
                    `• security = allowlist`,
                    `• ask = always（每次执行都需审批）`,
                    ``,
                    `每个命令都会弹出审批按钮，需手动确认。`,
                ].join("\n");
            }
            catch (err) {
                return `❌ 配置更新失败: ${err}`;
            }
        }
        // reset: 删除配置，恢复框架默认值
        if (arg === "reset") {
            try {
                const cfg = structuredClone(configApi.loadConfig());
                const tools = (cfg.tools ?? {});
                const exec = (tools.exec ?? {});
                delete exec.security;
                delete exec.ask;
                if (Object.keys(exec).length === 0) {
                    delete tools.exec;
                }
                else {
                    tools.exec = exec;
                }
                if (Object.keys(tools).length === 0) {
                    delete cfg.tools;
                }
                else {
                    cfg.tools = tools;
                }
                await configApi.writeConfigFile(cfg);
                return [
                    `✅ 审批配置已重置`,
                    ``,
                    `已移除 tools.exec.security 和 tools.exec.ask`,
                    `框架将使用默认值（security=deny, ask=on-miss）`,
                    ``,
                    `如需开启命令执行，请使用 /bot-approve on`,
                ].join("\n");
            }
            catch (err) {
                return `❌ 配置更新失败: ${err}`;
            }
        }
        return [
            `❌ 未知参数: ${arg}`,
            ``,
            `可用选项: on | off | always | reset`,
            `输入 /bot-approve ? 查看详细用法`,
        ].join("\n");
    },
});
// ============ 匹配入口 ============
/**
 * 尝试匹配并执行插件级斜杠指令
 *
 * @returns 回复文本（匹配成功），null（不匹配，应入队正常处理）
 */
export async function matchSlashCommand(ctx) {
    const content = ctx.rawContent.trim();
    if (!content.startsWith("/"))
        return null;
    // 解析指令名和参数
    const spaceIdx = content.indexOf(" ");
    const cmdName = (spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();
    const cmd = commands.get(cmdName);
    if (!cmd)
        return null; // 不是插件级指令，交给框架
    // /指令 ? — 返回用法说明
    if (args === "?") {
        if (cmd.usage) {
            return `📖 /${cmd.name} 用法：\n\n${cmd.usage}`;
        }
        return `/${cmd.name} — ${cmd.description}`;
    }
    ctx.args = args;
    const result = await cmd.handler(ctx);
    return result;
}
/** 获取插件版本号（供外部使用） */
export function getPluginVersion() {
    return PLUGIN_VERSION;
}
