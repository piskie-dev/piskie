/**
 * QQ 机器人内置渠道 connector
 *
 * 替代原 @tencent-connect/openclaw-qqbot 的 index.ts + channel.ts 胶水层
 * （凭证备份恢复/setup wizard/status 等 openclaw 宿主功能已裁剪——Piskie 凭证
 * 每次启动来自 ConfigHost 发布快照）。
 *
 * 协议实现见 ./vendor/（gateway 闭包 41 文件近原样收编，UPSTREAM.md 记录来源与改动）。
 */

import { setQQBotRuntime } from './vendor/src/runtime.js';
import { resolveQQBotAccount } from './vendor/src/config.js';
import { startGateway } from './vendor/src/gateway.js';
import { qqbotRuntimeHost } from './runtime-adapter.js';
import type { ChannelConnector, ConnectorFactory } from '../../core/channel-connector.js';

export const createQQBotConnector: ConnectorFactory = (_bot): ChannelConnector => ({
  id: 'qqbot',

  async start(ctx): Promise<void> {
    if (!ctx.bot.appId || !ctx.bot.appSecret) {
      throw new Error('QQ 机器人 AppID 或 ClientSecret 未配置');
    }

    setQQBotRuntime(qqbotRuntimeHost.buildRuntime());
    qqbotRuntimeHost.register(ctx);

    const cfg = qqbotRuntimeHost.loadConfig();
    const account = resolveQQBotAccount(cfg, ctx.bot.id);

    try {
      await startGateway({
        account,
        abortSignal: ctx.signal,
        cfg,
        log: {
          info: (...args: unknown[]) => ctx.log.info(...args),
          error: (...args: unknown[]) => ctx.log.error(...args),
        },
        onReady: () => {
          ctx.log.info('Gateway ready');
          ctx.setStatus({ running: true, connected: true, lastConnectedAt: Date.now() });
        },
        onError: (error) => {
          ctx.log.error(`Gateway error: ${error.message}`);
          ctx.setStatus({ lastError: error.message });
        },
      });
    } finally {
      qqbotRuntimeHost.unregister(ctx.bot.id);
    }
  },
});
