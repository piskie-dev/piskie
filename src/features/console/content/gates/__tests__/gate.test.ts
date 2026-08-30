/**
 * 门种类决策与作答派生的单测。
 *
 * 这两段在旧实现里都藏在组件内部（三段 `&&` 条件 + `resolveItemAnswer` 内联），
 * 一行测试都没有。抽成纯函数的直接收益就是它们现在有边界测试。
 */

import { describe, expect, it } from 'vitest';

import type { AIQuestionItem, PendingToolCall } from '../../../../../../shared/types';
import { EMPTY_DRAFT, isComplete, resolveItemAnswer, toggleSelection } from '../answer';
import { resolveGateRequest } from '../resolve';

function call(overrides: Partial<PendingToolCall> = {}): PendingToolCall {
  return {
    id: 'call-1',
    agentId: 'agent-1',
    mainAgentId: 'agent-1',
    toolName: 'common-tools.writeFile',
    params: {},
    timestamp: new Date(0),
    description: '写入文件',
    category: 'document',
    ...overrides,
  };
}

describe('resolveGateRequest', () => {
  it('无待审批也无提问时不出门', () => {
    expect(resolveGateRequest({})).toBeNull();
  });

  it('diff preview 走 diff 门', () => {
    const request = resolveGateRequest({
      pendingToolCall: call({
        preview: { type: 'diff', title: 'a.ts', content: '', stat: { linesAdded: 3, linesDeleted: 1 } },
      }),
    });
    expect(request?.kind).toBe('diff');
  });

  it('command / text preview 走命令门（shell 命令直接铺在门里，不给查看详情）', () => {
    const shell = resolveGateRequest({
      pendingToolCall: call({
        toolName: 'shell',
        preview: { type: 'command', title: 'Run shell command', content: 'rm -rf dist' },
      }),
    });
    expect(shell?.kind).toBe('command');

    const text = resolveGateRequest({
      pendingToolCall: call({
        preview: { type: 'text', title: 'Edit unavailable: a.ts', content: '说明' },
      }),
    });
    expect(text?.kind).toBe('command');
  });

  it('plan + action=create 走计划门，并取出 taskSummary', () => {
    const request = resolveGateRequest({
      pendingToolCall: call({ toolName: 'plan', params: { action: 'create', taskSummary: '抓取列表' } }),
    });
    expect(request).toMatchObject({ kind: 'plan', taskSummary: '抓取列表' });
  });

  it('plan 的其它 action 不走计划门', () => {
    const request = resolveGateRequest({
      pendingToolCall: call({ toolName: 'plan', params: { action: 'update' } }),
    });
    expect(request?.kind).toBe('tool');
  });

  it('taskSummary 缺失或非字符串时给空串，不抛', () => {
    const request = resolveGateRequest({
      pendingToolCall: call({ toolName: 'plan', params: { action: 'create', taskSummary: 42 } }),
    });
    expect(request).toMatchObject({ kind: 'plan', taskSummary: '' });
  });

  it('普通工具走工具门', () => {
    expect(resolveGateRequest({ pendingToolCall: call() })?.kind).toBe('tool');
  });

  it('待审批压过提问（与旧实现的 `&& !pendingToolCall`同义）', () => {
    const request = resolveGateRequest({
      pendingToolCall: call(),
      askUser: { id: 'q-1', items: [{ question: '继续吗？', multiSelect: false }] },
    });
    expect(request?.kind).toBe('tool');
  });

  it('只有提问时走提问门', () => {
    const request = resolveGateRequest({
      askUser: { id: 'q-1', items: [{ question: '继续吗？', multiSelect: false }] },
    });
    expect(request).toMatchObject({ kind: 'question', id: 'q-1' });
  });

  it('提问列表为空时不出门', () => {
    expect(resolveGateRequest({ askUser: { id: 'q-1', items: [] } })).toBeNull();
  });
});

const single: AIQuestionItem = { question: '选一个', options: ['A', 'B'], multiSelect: false };
const multi: AIQuestionItem = { question: '选多个', options: ['A', 'B'], multiSelect: true };

describe('resolveItemAnswer', () => {
  it('空草稿给空串', () => {
    expect(resolveItemAnswer(single, EMPTY_DRAFT)).toBe('');
  });

  it('单选取已选项', () => {
    expect(resolveItemAnswer(single, { selected: ['A'], custom: '' })).toBe('A');
  });

  it('单选时自由输入优先于已选项', () => {
    expect(resolveItemAnswer(single, { selected: ['A'], custom: '  自己写的  ' })).toBe('自己写的');
  });

  it('多选以「、」连接，按点击顺序', () => {
    expect(resolveItemAnswer(multi, { selected: ['B', 'A'], custom: '' })).toBe('B、A');
  });

  it('多选时自由输入追加在末尾', () => {
    expect(resolveItemAnswer(multi, { selected: ['A'], custom: '还有 C' })).toBe('A、还有 C');
  });

  it('纯空白的自由输入不算答案', () => {
    expect(resolveItemAnswer(single, { selected: [], custom: '   ' })).toBe('');
  });
});

describe('toggleSelection', () => {
  it('单选重复点击取消', () => {
    const once = toggleSelection(EMPTY_DRAFT, 'A', false);
    expect(once.selected).toEqual(['A']);
    expect(toggleSelection(once, 'A', false).selected).toEqual([]);
  });

  it('单选点另一个直接替换', () => {
    expect(toggleSelection({ selected: ['A'], custom: '' }, 'B', false).selected).toEqual(['B']);
  });

  it('多选累加与移除', () => {
    const a = toggleSelection(EMPTY_DRAFT, 'A', true);
    const ab = toggleSelection(a, 'B', true);
    expect(ab.selected).toEqual(['A', 'B']);
    expect(toggleSelection(ab, 'A', true).selected).toEqual(['B']);
  });

  it('不改动原草稿（不可变）', () => {
    const draft: ItemDraftShape = { selected: ['A'], custom: 'x' };
    toggleSelection(draft, 'B', true);
    expect(draft.selected).toEqual(['A']);
  });

  it('保留自由输入', () => {
    expect(toggleSelection({ selected: [], custom: '写了字' }, 'A', false).custom).toBe('写了字');
  });
});

type ItemDraftShape = { selected: string[]; custom: string };

describe('isComplete', () => {
  it('全部非空才算完成', () => {
    expect(isComplete(['A', 'B'])).toBe(true);
    expect(isComplete(['A', ''])).toBe(false);
    expect(isComplete([])).toBe(true);
  });
});
