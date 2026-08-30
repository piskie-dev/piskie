export const SUBAGENT_EVENT_TEXT_FIELDS = {
  message: ['text', 'message'],
  completed: ['text', 'message'],
  failed: ['text', 'error', 'message'],
  user_stopped: ['text', 'reason', 'message'],
  need_user_action: ['text', 'message'],
  stalled: ['text', 'message'],
} as const;

export type SubagentEventType = keyof typeof SUBAGENT_EVENT_TEXT_FIELDS;

export function isSubagentEventType(value: unknown): value is SubagentEventType {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(SUBAGENT_EVENT_TEXT_FIELDS, value);
}

/** Shared semantic text selection for runtime normalization and tolerant history reads. */
export function pickSubagentEventText(
  value: Readonly<Record<string, unknown>>,
  type: SubagentEventType,
): string | undefined {
  for (const field of SUBAGENT_EVENT_TEXT_FIELDS[type]) {
    const candidate = value[field];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
