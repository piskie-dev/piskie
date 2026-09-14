/**
 * 飞书内置渠道 connector
 *
 * 替代原 @larksuite/openclaw-lark 的 index.js + channel/plugin.js 胶水层。
 * 与 wecom 不同的胶水形态：lark 上游经 `LarkClient.setRuntime()` 静态缝消费宿主
 * 能力（触点散布 15 个文件），故注入渠道内部的 FeishuRuntimeHost（openclaw 形状
 * 的本地宿主，桥接框架 InboundPipeline），vendor 协议代码近乎零改动。
 *
 * 协议实现见 ./vendor/（按 require 闭包收编 103 文件，UPSTREAM.md 记录来源与改动）。
 */

import { monitorFeishuProvider } from './vendor/src/channel/monitor.js';
import { LarkClient } from './vendor/src/core/lark-client.js';
import { feishuRuntimeHost } from './runtime-adapter.js';
import type { ChannelConnector, ConnectorFactory } from '../../core/channel-connector.js';

export const createFeishuConnector: ConnectorFactory = (_bot): ChannelConnector => ({
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
