/**
 * 渠道事实表（双玻璃名册档案）。
 *
 * 四个内置渠道的展示事实与状态语义,全部以 channelId 为键
 * (渠道目录 `MessagingConnectorDescriptor.channelId`)。
 * 纯数据/纯函数,无 React、无 store 依赖。
 */

import type { BotStatus } from '../../../../shared/types/im-gateway';
import {
  messageText,
  rawText,
  type PresentationText,
} from '../../../i18n/presentationText';

/** 渠道显示名的 i18n key(缺席渠道回落 descriptor.displayName) */
export const CHANNEL_TITLE_KEYS: Record<string, string> = {
  feishu: 'imPlugin.pluginName_feishu',
  wecom: 'imPlugin.pluginName_wecom',
  qqbot: 'imPlugin.pluginName_qqbot',
  'openclaw-weixin': 'imPlugin.pluginName_weixin',
};

/** 头像铭牌字(渠道首字;未知渠道给 '?') */
export function channelMark(channelId: string): string {
  const marks: Record<string, string> = {
    feishu: '飞',
    wecom: '企',
    qqbot: 'Q',
    'openclaw-weixin': '微',
  };
  return marks[channelId] ?? '?';
}

/** 单渠道只允许一个 Bot 的渠道 */
export const SOLO_BOT_CHANNELS: ReadonlySet<string> = new Set(['wecom']);

/** 无凭证、走扫码登录生命周期的渠道 */
export const SCAN_LOGIN_CHANNELS: ReadonlySet<string> = new Set(['openclaw-weixin']);

/**
 * 静止判定:仅 stopped/error 允许删除与改绑
 * (starting/running/stopping/stop_failed 均视为占用中)
 */
export function atRest(status: BotStatus): boolean {
  return status === 'stopped' || status === 'error';
}

const STATUS_MESSAGE_KEYS: Record<BotStatus, string> = {
  stopped: 'imPlugin.connectionState.offline',
  starting: 'imPlugin.connectionState.connecting',
  running: 'imPlugin.connectionState.live',
  stopping: 'imPlugin.connectionState.disconnecting',
  stop_failed: 'imPlugin.connectionState.disconnectFailed',
  error: 'imPlugin.connectionState.connectionFault',
};

/** 已知状态使用产品文案，未知外部状态保留原文。 */
export function statusText(status: BotStatus | string): PresentationText {
  const key = STATUS_MESSAGE_KEYS[status as BotStatus];
  return key ? messageText(key) : rawText(String(status));
}

/** 私聊策略 → i18n key(顺序即分段器顺序;默认 pairing) */
export const DM_POLICY_KEYS = [
  ['open', 'imPlugin.accessAnyone'],
  ['pairing', 'imPlugin.accessAfterPairing'],
  ['allowlist', 'imPlugin.accessAllowlistOnly'],
  ['disabled', 'imPlugin.accessBlocked'],
] as const;

/** 群聊策略 → i18n key(无配对码;默认 disabled) */
export const GROUP_POLICY_KEYS = [
  ['open', 'imPlugin.accessAnyone'],
  ['allowlist', 'imPlugin.accessAllowlistOnly'],
  ['disabled', 'imPlugin.accessBlocked'],
] as const;

/** ISO 时间 → 可随 locale 重算的相对时间。 */
export function sinceText(iso: string): PresentationText {
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta) || delta < 0) {
    return messageText('imPlugin.relativeTime.momentsAgo');
  }
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return messageText('imPlugin.relativeTime.momentsAgo');
  if (minutes < 60) {
    return messageText('imPlugin.relativeTime.minutesEarlier', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return messageText('imPlugin.relativeTime.hoursEarlier', { count: hours });
  }
  return messageText('imPlugin.relativeTime.daysEarlier', { count: Math.floor(hours / 24) });
}
