/**
 * 企业微信内置渠道 connector
 *
 * 替代原 @wecom/wecom-openclaw-plugin 的 index.js + channel.js 胶水层：
 * - gateway.startAccount → start()（长驻 Promise 语义不变，abort 即停）
 * - openclaw runtime 注入（setWeComRuntime）→ 框架 ConnectorContext 参数下传
 * - setupWizard / status / config 账户管理 / mcp 工具等 openclaw 宿主功能已裁剪
 *   （Piskie 侧对应能力由 im-bots Config Domain + Connections UI 承担）
 *
 * 协议实现见 ./vendor/（近原样收编，UPSTREAM.md 记录来源与本地改动）。
 */

import { monitorWeComProvider } from './vendor/monitor.js';
import { resolveWeComAccount } from './account.js';
import type { ChannelConnector, ConnectorFactory } from '../../core/channel-connector.js';

export const createWeComConnector: ConnectorFactory = (_bot): ChannelConnector => ({
  id: 'wecom',

  async start(ctx): Promise<void> {
    const account = resolveWeComAccount(ctx.bot);
    if (!account.botId || !account.secret) {
      throw new Error('企业微信机器人 ID 或 Secret 未配置');
    }
    // vendor 协议代码以 runtime.log?.()/runtime.error?.() 形状消费日志
    const runtime = {
      log: (...args: unknown[]) => ctx.log.info(...args),
      error: (...args: unknown[]) => ctx.log.error(...args),
    };
    return monitorWeComProvider({
      account,
      runtime,
      abortSignal: ctx.signal,
      setStatus: (next) => ctx.setStatus(next),
      media: ctx.media,
      pairing: ctx.pairing,
      dispatch: ctx.dispatch,
    });
  },
});
