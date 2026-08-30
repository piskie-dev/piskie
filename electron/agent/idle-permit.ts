import type { Message } from '../../shared/types/index.js';
import { getValidPendingAskUser } from './context/conversation-protocol.js';

export type IdlePermit =
  | { kind: 'user_input'; callId: string }
  | { kind: 'user_action'; callId: string }
  | { kind: 'background_job'; taskId: string };

/** Derive every idle permit from durable conversation facts or a live job lease. */
export function deriveIdlePermits(
  messages: Message[],
  activeBackgroundTaskIds: readonly string[],
  isToolCallSuccessful: (callId: string) => boolean,
): IdlePermit[] {
  const permits: IdlePermit[] = [];
  const pending = getValidPendingAskUser(messages);
  if (pending) permits.push({ kind: 'user_input', callId: pending.toolUseId });

  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (latestAssistant && Array.isArray(latestAssistant.content)) {
    for (const block of latestAssistant.content) {
      if (
        block.type === 'tool_use'
        && block.name === 'send_event'
        && block.id
        && isToolCallSuccessful(block.id)
        && typeof block.input === 'object'
        && block.input !== null
        && (block.input as Record<string, unknown>).type === 'need_user_action'
      ) {
        permits.push({ kind: 'user_action', callId: block.id });
      }
    }
  }

  for (const taskId of activeBackgroundTaskIds) {
    permits.push({ kind: 'background_job', taskId });
  }
  return permits;
}
