import type { IMReplyForwardConfig } from '../../shared/types/im-gateway.js';

export const DEFAULT_REPLY_FORWARD_CONFIG: Readonly<IMReplyForwardConfig> = Object.freeze({
  forwardAssistantText: true,
  forwardToolCalls: false,
  forwardToolResults: false,
});
