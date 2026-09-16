/**
 * 飞书内置渠道 connector
 *
 * 替代原 @larksuite/openclaw-lark 的 index.js + channel/plugin.js 胶水层。
 * 与 wecom 不同的胶水形态：lark 上游经 `LarkClient.setRuntime()` 静态缝消费宿主
 * 能力（触点散布 15 个文件），故注入渠道内部的 FeishuRuntimeHost（openclaw 形状
 * 的本地宿主，桥接框架 InboundPipeline），vendor 协议代码近乎零改动。
 *
 * 协议实现见 ./vendor/（按 require 闭包收编 103 文件，UPSTREAM.md 记录来源与改动）。
 *
 * 存储：用户授权 token（UAT）落在 Piskie 专属位置——macOS Keychain service
 * `piskie-feishu-uat`，Linux/Windows `<userData>/im-gateway/feishu/credentials`
 * （由宿主经 ChannelStoragePaths 注入，见 ./storage.ts）；不迁移旧 OpenClaw 凭据，需重新授权。
 */

import { monitorFeishuProvider } from './vendor/src/channel/monitor.js';
import { LarkClient } from './vendor/src/core/lark-client.js';
import { feishuRuntimeHost } from './runtime-adapter.js';
import { bindFeishuStorage } from './storage.js';
import type { ChannelConnector, ConnectorFactory } from '../../core/channel-connector.js';
import type { ChannelStoragePaths } from '../../core/channel-storage.js';

/** 返回 feishu 渠道的 ConnectorFactory；每次创建 Connector 都重新绑定凭据存储位置。 */
export function createFeishuConnector(storage: ChannelStoragePaths): ConnectorFactory {
  return (_bot): ChannelConnector => {
    bindFeishuStorage(storage);
    return buildFeishuConnector();
  };
}

const buildFeishuConnector = (): ChannelConnector => ({
  id: 'feishu',

  async start(ctx): Promise<void> {
    if (!ctx.bot.appId || !ctx.bot.appSecret) {
      throw new Error('飞书 App ID 或 App Secret 未配置');
    }

    // 注入 openclaw 形状宿主（幂等）并注册本 bot 的连接上下文
    LarkClient.setRuntime(feishuRuntimeHost.buildRuntime());
    feishuRuntimeHost.register(ctx);

    const runtime = {
      abortSignal: ctx.signal,
      log: (...args: unknown[]) => ctx.log.info(...args),
      error: (...args: unknown[]) => ctx.log.error(...args),
    };

    try {
      // 单账号模式：monitorFeishuProvider 内部经 getLarkAccount(cfg, accountId) 解析凭证；
      // 初始 config 与运行期 LarkClient.runtime.config.loadConfig() 同源（活跃 bot 聚合）
      await monitorFeishuProvider({
        config: feishuRuntimeHost.loadConfig(),
        runtime,
        abortSignal: ctx.signal,
        accountId: ctx.bot.id,
      });
    } finally {
      feishuRuntimeHost.unregister(ctx.bot.id);
      await LarkClient.clearCache(ctx.bot.id).catch(() => {});
    }
  },
});
