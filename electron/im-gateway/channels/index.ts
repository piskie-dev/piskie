/**
 * 内置渠道注册；Config Contract 与 Connector 共用 CHANNEL_DESCRIPTORS。
 *
 * 各渠道的持久化存储位置（ChannelStoragePaths）由 IMGateway 按 userData/tmpdir 解析后
 * 在此注入到渠道工厂，长期连接与扫码/退出等临时 Connector 共用同一套路径。
 */

import { channelRegistry } from '../core/registry.js';
import { createWeComConnector } from './wecom/index.js';
import { createFeishuConnector } from './feishu/index.js';
import { createQQBotConnector } from './qqbot/index.js';
import { createWeixinConnector } from './weixin/index.js';
import type { ConnectorFactory } from '../core/channel-connector.js';
import type { ChannelStoragePaths } from '../core/channel-storage.js';
import {
  CHANNEL_DESCRIPTORS,
  type ChannelKey,
} from '../channel-descriptors.js';
import type { MessagingConnectorDescriptor } from '@shared/types/im-gateway.js';

export function registerBuiltinChannels(storage: ChannelStoragePaths): void {
  const factories = buildChannelFactories(storage);
  for (const descriptor of CHANNEL_DESCRIPTORS) {
    channelRegistry.register(descriptor.channelKey, factories[descriptor.channelKey]);
  }
}

function buildChannelFactories(storage: ChannelStoragePaths): Record<ChannelKey, ConnectorFactory> {
  return {
    wecom: createWeComConnector(storage),
    feishu: createFeishuConnector(storage),
    qqbot: createQQBotConnector(storage),
    'openclaw-weixin': createWeixinConnector(storage),
  };
}

/** 安装 UI 使用的内置渠道展示元数据。 */
export const BUILTIN_CHANNEL_INFOS: MessagingConnectorDescriptor[] = [
  { packageName: '@wecom/wecom-openclaw-plugin', version: 'builtin', channelId: 'wecom', displayName: '企业微信' },
  { packageName: '@larksuite/openclaw-lark', version: 'builtin', channelId: 'feishu', displayName: '飞书' },
  { packageName: '@tencent-connect/openclaw-qqbot', version: 'builtin', channelId: 'qqbot', displayName: 'QQ 机器人' },
  { packageName: '@tencent-weixin/openclaw-weixin', version: 'builtin', channelId: 'openclaw-weixin', displayName: '微信个人号' },
];
