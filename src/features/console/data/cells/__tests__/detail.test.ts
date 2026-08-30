import { describe, expect, it } from 'vitest';

import { projectConversationNodes } from '@/domains/transcript/project-entry';
import type { ConversationEntry } from '../../../../../../shared/types/agent-control';
import { messageText } from '../../presentationText';
import { toolSections } from '../detail';

describe('canonical tool detail', () => {
  it('renders one structured result section without labels, roles, or duplicate views', () => {
    const params = { request: 'x' };
    const result = { message: 'fact', nested: [1, 2] };
    expect(toolSections({ tool: 'unknown', params, result, state: { phase: 'ok' } }))
      .toEqual([
        { value: params, format: 'json' },
        { value: result, format: 'json' },
      ]);
  });

  it('renders non-JSON text once in its original form', () => {
    expect(toolSections({
      tool: 'unknown',
      result: 'Successfully navigated to https://example.test/',
      state: { phase: 'ok' },
    })).toEqual([{
      value: 'Successfully navigated to https://example.test/',
      format: 'text',
    }]);
  });

  it('keeps a typed artifact and the canonical diagnostic result as separate facts', () => {
    const answers = [{ question: '继续吗？', answer: '继续' }];
    const result = { answers: ['继续'] };
    expect(toolSections({
      tool: 'ask_user',
      params: { questions: [{ question: '继续吗？' }] },
      result,
      state: { phase: 'ok' },
      questionAnswers: answers,
    })).toEqual([
      { value: answers, format: 'question_answers' },
      { value: { questions: [{ question: '继续吗？' }] }, format: 'json' },
      { value: result, format: 'json' },
    ]);
  });

  it('uses a typed artifact before params or result text for the collapsed summary', () => {
    const entries: ConversationEntry[] = [
      {
        t: 'msg',
        ts: 1,
        id: 'm-artifact',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call-artifact',
          name: 'ask_user',
          input: { questions: [{ question: '继续吗？' }] },
        }],
      },
      {
        t: 'tool',
        ts: 2,
        toolUseId: 'call-artifact',
        ok: true,
        result: [{ type: 'text', text: '["继续"]' }],
        artifacts: [{ kind: 'ask_user_answers', payload: { answers: ['继续'] } }],
      },
    ];
    const node = projectConversationNodes(entries).find((item) => item.id === 'call-artifact');
    expect(node?.summary).toEqual(messageText('transcript.summary.answerCount', { count: 1 }));
  });

  it('parses a persisted JSON container once and does not guess its message field', () => {
    const entries: ConversationEntry[] = [
      {
        t: 'msg',
        ts: 1,
        id: 'm1',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call-1',
          name: 'unknown_tool',
          input: { message: 'input guess', action: 'click' },
        }],
      },
      {
        t: 'tool',
        ts: 2,
        toolUseId: 'call-1',
        ok: true,
        result: [{ type: 'text', text: '{"message":"result guess","value":1}' }],
      },
    ];
    const node = projectConversationNodes(entries).find((item) => item.id === 'call-1');
    expect(node?.kind).toBe('tool');
    if (node?.kind !== 'tool') throw new Error('tool node missing');

    expect(node.summary).toEqual(messageText('transcript.summary.completed'));
    const sections = node.detail?.().sections ?? [];
    expect(sections.filter((section) => (
      typeof section.value === 'object'
      && section.value !== null
      && 'value' in section.value
    ))).toEqual([{
      value: { message: 'result guess', value: 1 },
      format: 'json',
    }]);
  });
});
