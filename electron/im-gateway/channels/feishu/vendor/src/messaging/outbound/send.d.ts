/**
 * PISKIE 手写类型声明（仅声明迟到帧兜底消费的入口）
 */
export function sendMessageFeishu(params: {
  cfg: Record<string, unknown>;
  to: string;
  text: string;
  accountId?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
}): Promise<{ channel: string; messageId?: string }>;
