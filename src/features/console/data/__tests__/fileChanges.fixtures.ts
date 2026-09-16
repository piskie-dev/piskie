import type { ConversationEntry, MsgEntry, ToolEntry } from '@shared/types';
import type { ConversationPageRequest } from '@shared/electron-contracts/agents';
import type { ConversationPageSource } from '@/domains/transcript/transcript-session';
import { neutralizeClosing } from '../../../../../electron/agent/prompts/context';

export const samplePath = '/workspace/sample.txt';

export function user(id: string, text = id, ts = 1): Extract<MsgEntry, { role: 'user' }> {
  return { t: 'msg', role: 'user', subtype: 'user_input', id, ts, content: text };
}

export function parent(id: string, text: string, ts = 3, sentAt = ts): MsgEntry {
  return { ...user(id, text, ts), subtype: 'system_event', content: `<agent_input source="parent" ts="${new Date(sentAt).toISOString()}">\n${neutralizeClosing('agent_input', text)}\n</agent_input>` };
}

export function call(id: string, name: string, input: Record<string, unknown>, ts = 2): MsgEntry {
  return { t: 'msg', role: 'assistant', id: `message-${id}`, ts, content: [{ type: 'tool_use', id, name, input }] };
}

export function result(id: string, text = 'Recorded.', ts = 3): ToolEntry {
  return { t: 'tool', toolUseId: id, ts, ok: true, result: [{ type: 'text', text }] };
}

export function createWorker(workerId: string, ts = 2): ConversationEntry[] {
  return [call(`create-${workerId}`, 'subagent', { subject: 'Sample task', prompt: 'Inspect the sample.' }, ts),
    result(`create-${workerId}`, `subagentId: ${workerId}`, ts + 1)];
}

export function write(id: string, content = 'alpha', path = samplePath, ts = 2): ConversationEntry[] {
  return [call(id, 'write', { file_path: path, content }, ts), result(id, 'Written.', ts + 1)];
}

export function edit(id: string, oldText: string, newText: string, ts = 2): ConversationEntry[] {
  return [call(id, 'edit', { file_path: samplePath, edits: [{ old_string: oldText, new_string: newText }] }, ts), result(id, 'Edited.', ts + 1)];
}

export function pageSource(records: ReadonlyMap<string, readonly ConversationEntry[]>): ConversationPageSource {
  return { conversation: async (id: string, request: ConversationPageRequest) => {
    const entries = records.get(id) ?? [];
    const end = request.direction === 'backward' ? request.before : entries.length;
    const from = request.direction === 'forward' ? request.from : Math.max(0, end - request.limit);
    return { from, entries: entries.slice(from, Math.min(end, from + request.limit)), total: entries.length };
  } };
}
