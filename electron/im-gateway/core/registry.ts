/** ChannelRegistry — canonical channelType 到内置 ConnectorFactory 的唯一注册表。 */

import type { ChannelConnector, ConnectorFactory } from './channel-connector.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

class ChannelRegistry {
  private factories = new Map<string, ConnectorFactory>();

  /** 注册内置渠道（channelKey 为 channel-descriptors 中的规范 key） */
  register(channelKey: string, factory: ConnectorFactory): void {
    this.factories.set(channelKey, factory);
  }

  /** canonical channelType 是否已有内置实现 */
  has(channelType: string): boolean {
    return this.factories.has(channelType);
  }

  /** 为 bot 创建 connector 实例（每次启动新建，不复用连接状态） */
  create(bot: MessagingConnectionConfig): ChannelConnector | null {
    const factory = this.factories.get(bot.channelType);
    return factory ? factory(bot) : null;
  }

  list(): string[] {
    return [...this.factories.keys()].sort();
  }
}

export const channelRegistry = new ChannelRegistry();
