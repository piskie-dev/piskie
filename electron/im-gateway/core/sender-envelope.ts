/**
 * 群聊 sender 信封与 senderId 防御校验
 *
 * - senderId 是所有渠道进站的非空必填值：缺失、空白或哨兵值（vendor fallback
 *   的 "unknown"）必须在命令/ask 结算/inject 前拒绝
 * - 群消息正文前加单行 JSON 信封 `[IM_GROUP_MEMBER {"id":...,"name":...}]`；
 *   经 JSON.stringify 转义并额外处理 NEL/U+2028/U+2029，保证信封恒占一行
 * - 私聊正文原样，不重复加入本来由 peer 唯一确定的发送者
 * - 信封只是给模型的上下文，不是鉴权凭据，不进入 Agent Session 路由/ReplyBinding/Header
 */

import type { InboundMessage } from './channel-connector.js';

export const SENDER_REJECT_REPLY = '无法识别发送者身份，本条消息未处理';

/** trim() 只做空白校验，信封仍使用原始稳定值；禁止把缺失值回填成 unknown */
export function hasValidSenderId(senderId: string | undefined | null): boolean {
  if (typeof senderId !== 'string') return false;
  const trimmed = senderId.trim();
  return trimmed.length > 0 && trimmed !== 'unknown';
}

export function buildAgentText(message: InboundMessage, messageText: string): string {
  if (message.peer.kind === 'direct') return messageText;

  // JSON.stringify 已转义引号/反斜线/换行；NEL/U+2028/U+2029 是 JSON 合法裸字符，
  // 需额外转义才能保证信封只占一行
  const sender = JSON.stringify({
    id: message.senderId,
    name: message.senderName ?? null,
  })
    .replace(/\u0085/g, '\\u0085')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `[IM_GROUP_MEMBER ${sender}]\n${messageText}`;
}
