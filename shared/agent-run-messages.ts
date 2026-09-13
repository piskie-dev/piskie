import type { ConversationEntry, MsgEntry } from './types/agent-control.js';

/** Main conversation positions use the same zero-based index as conversation paging. */
export interface AgentRunMessageState {
  readonly latestMessage: { readonly index: number; readonly timestamp: number } | null;
  readonly latestAssistantIndex: number;
  readonly readThroughIndex: number;
}

export function isVisibleConversationMessage(entry: ConversationEntry): entry is MsgEntry {
  if (entry.t !== 'msg') return false;
  if (entry.role === 'user') {
    return entry.subtype === 'user_input' || entry.subtype === 'system_task';
  }
  return typeof entry.content === 'string'
    ? entry.content.trim().length > 0
    : entry.content.some((block) => block.type === 'text' && !!block.text?.trim());
}

export function hasUnreadMessages(state: AgentRunMessageState | undefined): boolean {
  return !!state && state.latestAssistantIndex > state.readThroughIndex;
}

/** List responses, append observations and read acknowledgements can cross in transit. */
export function mergeMessageState(
  current: AgentRunMessageState | undefined,
  incoming: AgentRunMessageState,
): AgentRunMessageState {
  if (!current) return incoming;
  return {
    latestMessage: (current.latestMessage?.index ?? -1) > (incoming.latestMessage?.index ?? -1)
      ? current.latestMessage : incoming.latestMessage,
    latestAssistantIndex: Math.max(current.latestAssistantIndex, incoming.latestAssistantIndex),
    readThroughIndex: Math.max(current.readThroughIndex, incoming.readThroughIndex),
  };
}
