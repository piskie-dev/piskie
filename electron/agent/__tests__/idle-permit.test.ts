import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '../../../shared/types/index.js';
import { deriveIdlePermits } from '../idle-permit.js';

const toolUse = (id: string, name: string, input: unknown): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
} as ContentBlock);

const assistant = (...content: ContentBlock[]): Message => ({ role: 'assistant', content });
const result = (id: string): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'done' } as ContentBlock],
});

describe('deriveIdlePermits', () => {
  it('derives pending user input from the unresolved ask_user call', () => {
    const messages = [assistant(toolUse('ask-1', 'ask_user', {
      questions: [{ question: '继续吗？' }],
    }))];

    expect(deriveIdlePermits(messages, [], () => false)).toEqual([
      { kind: 'user_input', callId: 'ask-1' },
    ]);
    expect(deriveIdlePermits([...messages, result('ask-1')], [], () => false)).toEqual([]);
  });

  it('derives user action only from a successfully settled latest assistant call', () => {
    const request = assistant(toolUse('event-1', 'send_event', { type: 'need_user_action' }));
    expect(deriveIdlePermits([request, result('event-1')], [], id => id === 'event-1')).toEqual([
      { kind: 'user_action', callId: 'event-1' },
    ]);
    expect(deriveIdlePermits([request, result('event-1')], [], () => false)).toEqual([]);

    const movedOn = assistant({ type: 'text', text: '父级回复后继续处理' } as ContentBlock);
    expect(deriveIdlePermits(
      [request, result('event-1'), movedOn],
      [],
      id => id === 'event-1',
    )).toEqual([]);
  });

  it('derives one permit for each active background lease', () => {
    expect(deriveIdlePermits([], ['task-a', 'task-b'], () => false)).toEqual([
      { kind: 'background_job', taskId: 'task-a' },
      { kind: 'background_job', taskId: 'task-b' },
    ]);
  });
});
