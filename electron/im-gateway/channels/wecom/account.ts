/**
 * 企业微信账户配置解析
 *
 * 从 PISKIE 的 MessagingConnectionConfig 直接派生（字段映射见 channel-descriptors.ts 的
 * wecom topLevelCredentials）。
 */

import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

/** 企业微信官方 WebSocket 端点 */
const DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com';

/** vendor 协议代码消费的账户形状 */
export interface WeComAccount {
  accountId: string;
  name: string;
  botId: string;
  secret: string;
  websocketUrl: string;
  sendThinkingMessage: boolean;
  /** 访问控制与媒体配置（group-policy / dm-policy / monitor 读取） */
  config: {
    dmPolicy?: 'open' | 'pairing' | 'allowlist' | 'disabled';
    allowFrom?: string[];
    groupPolicy?: 'open' | 'allowlist' | 'disabled';
    groupAllowFrom?: string[];
    /** 按群维度的发送者白名单（PISKIE 暂无 UI 产生，保留字段形状） */
    groups?: Record<string, { allowFrom?: string[] }>;
    /** 出站本地媒体白名单扩展（PISKIE 暂无 UI 产生，保留字段形状） */
    mediaLocalRoots?: string[];
    /** 进站媒体大小上限 MB（默认 5，见 vendor/const.js DEFAULT_MEDIA_MAX_MB） */
    mediaMaxMb?: number;
  };
}

export function resolveWeComAccount(bot: MessagingConnectionConfig): WeComAccount {
  return {
    accountId: bot.id,
    name: bot.name,
    botId: bot.appId ?? '',
    secret: bot.appSecret ?? '',
    websocketUrl: DEFAULT_WS_URL,
    sendThinkingMessage: true,
    config: {
      dmPolicy: bot.dmPolicy,
      allowFrom: bot.allowFrom,
      groupPolicy: bot.groupPolicy,
      groupAllowFrom: bot.groupAllowFrom,
    },
  };
}
