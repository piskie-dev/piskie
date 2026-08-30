import { DEFAULT_ACCOUNT_ID, listQQBotAccountIds, resolveQQBotAccount } from "./config.js";
/**
 * 解析默认账户 ID
 */
function resolveDefaultQQBotAccountId(cfg) {
    const ids = listQQBotAccountIds(cfg);
    return ids[0] ?? DEFAULT_ACCOUNT_ID;
}
/**
 * QQBot Onboarding Adapter
 */
export const qqbotOnboardingAdapter = {
    channel: "qqbot",
    getStatus: async (ctx) => {
        const cfg = ctx.cfg;
        const configured = listQQBotAccountIds(cfg).some((accountId) => {
            const account = resolveQQBotAccount(cfg, accountId);
            return Boolean(account.appId && account.clientSecret);
        });
        return {
            channel: "qqbot",
            configured,
            statusLines: [`QQ Bot: ${configured ? "已配置" : "需要 AppID 和 ClientSecret"}`],
            selectionHint: configured ? "已配置" : "支持 QQ 群聊和私聊（流式消息）",
            quickstartScore: configured ? 1 : 20,
        };
    },
    configure: async (ctx) => {
        const cfg = ctx.cfg;
        const prompter = ctx.prompter;
        const accountOverrides = ctx.accountOverrides;
        const shouldPromptAccountIds = ctx.shouldPromptAccountIds;
        const qqbotOverride = accountOverrides?.qqbot?.trim();
        const defaultAccountId = resolveDefaultQQBotAccountId(cfg);
        let accountId = qqbotOverride ?? defaultAccountId;
        // 是否需要提示选择账户
        if (shouldPromptAccountIds && !qqbotOverride) {
            const existingIds = listQQBotAccountIds(cfg);
            if (existingIds.length > 1) {
                accountId = await prompter.select({
                    message: "选择 QQBot 账户",
                    options: existingIds.map((id) => ({
                        value: id,
                        label: id === DEFAULT_ACCOUNT_ID ? "默认账户" : id,
                    })),
                    initialValue: accountId,
                });
            }
        }
        let next = cfg;
        const resolvedAccount = resolveQQBotAccount(next, accountId);
        const accountConfigured = Boolean(resolvedAccount.appId && resolvedAccount.clientSecret);
        const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
        const envAppId = typeof process !== "undefined" ? process.env?.QQBOT_APP_ID?.trim() : undefined;
        const envSecret = typeof process !== "undefined" ? process.env?.QQBOT_CLIENT_SECRET?.trim() : undefined;
        const canUseEnv = allowEnv && Boolean(envAppId && envSecret);
        const hasConfigCredentials = Boolean(resolvedAccount.config.appId && resolvedAccount.config.clientSecret);
        let appId = null;
        let clientSecret = null;
        // 显示帮助
        if (!accountConfigured) {
            await prompter.note([
                "1) 打开 QQ 开放平台: https://q.qq.com/",
                "2) 创建机器人应用，获取 AppID 和 ClientSecret",
                "3) 在「开发设置」中添加沙箱成员（测试阶段）",
                "4) 你也可以设置环境变量 QQBOT_APP_ID 和 QQBOT_CLIENT_SECRET",
                "",
                "文档: https://bot.q.qq.com/wiki/",
                "",
                "此版本支持流式消息发送！",
            ].join("\n"), "QQ Bot 配置");
        }
        // 检测环境变量
        if (canUseEnv && !hasConfigCredentials) {
            const keepEnv = await prompter.confirm({
                message: "检测到环境变量 QQBOT_APP_ID 和 QQBOT_CLIENT_SECRET，是否使用？",
                initialValue: true,
            });
            if (keepEnv) {
                next = {
                    ...next,
                    channels: {
                        ...next.channels,
                        qqbot: {
                            ...(next.channels?.qqbot || {}),
                            enabled: true,
                            allowFrom: resolvedAccount.config?.allowFrom ?? ["*"],
                        },
                    },
                };
            }
            else {
                // 手动输入
                appId = String(await prompter.text({
                    message: "请输入 QQ Bot AppID",
                    placeholder: "例如: 102146862",
                    initialValue: resolvedAccount.appId || undefined,
                    validate: (value) => (value?.trim() ? undefined : "AppID 不能为空"),
                })).trim();
                clientSecret = String(await prompter.text({
                    message: "请输入 QQ Bot ClientSecret",
                    placeholder: "你的 ClientSecret",
                    validate: (value) => (value?.trim() ? undefined : "ClientSecret 不能为空"),
                })).trim();
            }
        }
        else if (hasConfigCredentials) {
            // 已有配置
            const keep = await prompter.confirm({
                message: "QQ Bot 已配置，是否保留当前配置？",
                initialValue: true,
            });
            if (!keep) {
                appId = String(await prompter.text({
                    message: "请输入 QQ Bot AppID",
                    placeholder: "例如: 102146862",
                    initialValue: resolvedAccount.appId || undefined,
                    validate: (value) => (value?.trim() ? undefined : "AppID 不能为空"),
                })).trim();
                clientSecret = String(await prompter.text({
                    message: "请输入 QQ Bot ClientSecret",
                    placeholder: "你的 ClientSecret",
                    validate: (value) => (value?.trim() ? undefined : "ClientSecret 不能为空"),
                })).trim();
            }
        }
        else {
            // 没有配置，需要输入
            appId = String(await prompter.text({
                message: "请输入 QQ Bot AppID",
                placeholder: "例如: 102146862",
                initialValue: resolvedAccount.appId || undefined,
                validate: (value) => (value?.trim() ? undefined : "AppID 不能为空"),
            })).trim();
            clientSecret = String(await prompter.text({
                message: "请输入 QQ Bot ClientSecret",
                placeholder: "你的 ClientSecret",
                validate: (value) => (value?.trim() ? undefined : "ClientSecret 不能为空"),
            })).trim();
        }
        // 默认允许所有人执行命令（用户无感知）
        const allowFrom = resolvedAccount.config?.allowFrom ?? ["*"];
        // 应用配置（markdownSupport 默认开启，如需关闭可用 set-markdown.sh）
        if (appId && clientSecret) {
            const existingQQBot = next.channels?.qqbot || {};
            // 保留已有的 markdownSupport 设置，新装默认 true
            const markdownSupport = existingQQBot.markdownSupport ?? true;
            if (accountId === DEFAULT_ACCOUNT_ID) {
                next = {
                    ...next,
                    channels: {
                        ...next.channels,
                        qqbot: {
                            ...existingQQBot,
                            enabled: true,
                            appId,
                            clientSecret,
                            markdownSupport,
                            allowFrom,
                        },
                    },
                };
            }
            else {
                const existingAccounts = (next.channels?.qqbot?.accounts || {});
                const existingAccount = existingAccounts[accountId] || {};
                const acctMarkdown = existingAccount.markdownSupport ?? true;
                next = {
                    ...next,
                    channels: {
                        ...next.channels,
                        qqbot: {
                            ...existingQQBot,
                            enabled: true,
                            accounts: {
                                ...existingAccounts,
                                [accountId]: {
                                    ...existingAccount,
                                    enabled: true,
                                    appId,
                                    clientSecret,
                                    markdownSupport: acctMarkdown,
                                    allowFrom,
                                },
                            },
                        },
                    },
                };
            }
        }
        return { success: true, cfg: next, accountId };
    },
    disable: (cfg) => {
        const config = cfg;
        return {
            ...config,
            channels: {
                ...config.channels,
                qqbot: { ...(config.channels?.qqbot || {}), enabled: false },
            },
        };
    },
};
