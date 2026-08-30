/**
 * Channel Descriptor — Config Contract 与 Connector Registry 的唯一渠道声明。
 */

export interface ChannelDescriptor {
  /** 规范渠道 key（channels/ 注册名） */
  channelKey: string;
  /** Credential shape consumed by the Config Domain contract. */
  credentialKind: 'application' | 'account';
}

export const CHANNEL_DESCRIPTORS = [
  { channelKey: 'feishu', credentialKind: 'application' },
  { channelKey: 'wecom', credentialKind: 'application' },
  { channelKey: 'qqbot', credentialKind: 'application' },
  { channelKey: 'openclaw-weixin', credentialKind: 'account' },
] as const satisfies readonly ChannelDescriptor[];

export type ChannelKey = typeof CHANNEL_DESCRIPTORS[number]['channelKey'];
