/**
 * 微信个人号内置渠道 connector
 *
 * 与其它渠道不同：weixin 的 channel.js（含 QR 登录三接口与 startAccount 包装）
 * 是协议胶水的一部分，整体收编——connector 直接消费 weixinPlugin 对象，
 * 复刻旧 IMGateway 插件轨的调用形状（credentialId = pluginAccountId || bot.id，
 * QR 登录后插件真实账号 ID 由 IMGateway 写入独立 account-session state）。
 *
 * 登录态/凭证存储在 `~/.openclaw`（协议核心内部逻辑，收编后路径不变，登录态无缝保留）。
 */

import { weixinPlugin } from './vendor/src/channel.js';
import {
  clearLegacyWeixinCredential,
  clearWeixinAccount,
  deriveRawAccountId,
  isUsingLegacyWeixinCredential,
  unregisterWeixinAccountId,
} from './vendor/src/auth/accounts.js';
import { clearContextTokensForAccount } from './vendor/src/messaging/inbound.js';
import { weixinRuntimeHost } from './runtime-adapter.js';
import { normalizeAccountId } from '../../core/openclaw-compat/account-id.js';
import type { ChannelConnector, ConnectorFactory } from '../../core/channel-connector.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

function buildPluginLog(log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void }) {
  return {
    info: (...args: unknown[]) => log.info(...args),
    warn: (...args: unknown[]) => log.warn(...args),
    error: (...args: unknown[]) => log.error(...args),
    debug: (...args: unknown[]) => log.debug(...args),
  };
}

export const createWeixinConnector: ConnectorFactory = (bot: MessagingConnectionConfig): ChannelConnector => ({
  id: 'openclaw-weixin',

  async start(ctx): Promise<void> {
    // A connector stopped before it starts must not touch credentials or the network.
    if (ctx.signal.aborted) return;

    weixinRuntimeHost.register(ctx);
    let account: ReturnType<typeof weixinPlugin.config.resolveAccount> | undefined;
    try {
      const runtime = weixinRuntimeHost.buildRuntime();
      const channelRuntime = runtime.channel as Record<string, unknown> | undefined;
      if (!channelRuntime) throw new Error('Weixin runtime is missing channelRuntime');

      const cfg = weixinRuntimeHost.loadConfig();
      // QR 渠道：凭证按插件真实账号 ID（扫码后保存）解析，兜底 bot.id
      const credentialId = ctx.bot.pluginAccountId || ctx.bot.id;
      account = weixinPlugin.config.resolveAccount(cfg, credentialId);
      let pluginStatus: Record<string, unknown> = {};
      await weixinPlugin.gateway.startAccount({
        cfg,
        accountId: ctx.bot.id,
        account,
        runtime,
        channelRuntime,
        abortSignal: ctx.signal,
        setStatus: (next) => {
          pluginStatus = { ...pluginStatus, ...next };
          ctx.setStatus(pluginStatus);
        },
        getStatus: () => pluginStatus,
        log: buildPluginLog(ctx.log),
      });
    } finally {
      try {
        if (account) await weixinPlugin.gateway.stopAccount({ account, timeoutMs: 2_000 });
      } finally {
        weixinRuntimeHost.unregister(ctx.bot.id);
      }
    }
  },

  // ── QR 登录（无需 bot 运行即可调用；IMGateway 双轨分流至此）──

  async loginWithQrStart(opts) {
    return weixinPlugin.gateway.loginWithQrStart({
      accountId: opts.accountId,
      credentialAccountId: bot.pluginAccountId,
      force: opts.force ?? false,
    });
  },

  async loginWithQrWait(opts) {
    return weixinPlugin.gateway.loginWithQrWait({
      accountId: opts.accountId,
      credentialAccountId: bot.pluginAccountId,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  },

  async loginWithQrSubmitCode(opts) {
    return weixinPlugin.gateway.loginWithQrSubmitCode({
      accountId: opts.accountId,
      code: opts.code,
    });
  },

  async loginWithQrCancel(opts) {
    return weixinPlugin.gateway.loginWithQrCancel({ accountId: opts.accountId });
  },

  async logoutAccount(opts) {
    const normalizedId = normalizeAccountId(bot.pluginAccountId || opts.accountId);
    const usedLegacyCredential = isUsingLegacyWeixinCredential(normalizedId);
    clearContextTokensForAccount(normalizedId);
    const rawId = deriveRawAccountId(normalizedId);
    if (rawId) clearContextTokensForAccount(rawId);
    clearWeixinAccount(normalizedId);
    unregisterWeixinAccountId(normalizedId);
    if (usedLegacyCredential) clearLegacyWeixinCredential();
    return { cleared: true, loggedOut: false };
  },
});
