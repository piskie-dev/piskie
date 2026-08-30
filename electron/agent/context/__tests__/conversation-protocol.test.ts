/**
 * 对话协议核心单测：
 * - ask 参数非法（空数组/缺 question/旧单 question 形状）的判定
 * - 最新 assistant 是纯文本 → inspectLatestToolBatch 返回 undefined，不向前修复
 * - 最新批次完整、较早 call 缺结果 → 无事可做，不向前修复
 * - 较早存在损坏的同 ID call、尾部表面合法 ask → 不判 pending，确保结算目标唯一
 * - canonical interrupted builder 形状
 */
import { describe, it, expect } from 'vitest';

import {
  parseAskUserInput,
  inspectLatestToolBatch,
  resolveToolUseSettlement,
  getValidPendingAskUser,
  getUnsettledValidAskCalls,
  buildToolInterruptionResult,
  ASK_USER_GATE_VIOLATION_TEXT,
} from '../conversation-protocol.js';
import type { Message, ContentBlock } from '../../../../shared/types/index.js';

const tu = (id: string, name = 'ask_user', input: unknown = { questions: [{ question: 'Q?' }] }): ContentBlock =>
  ({ type: 'tool_use', id, name, input } as ContentBlock);
const tr = (id: string, content: unknown = 'ok'): ContentBlock =>
  ({ type: 'tool_result', tool_use_id: id, content } as unknown as ContentBlock);
const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const asst = (...blocks: ContentBlock[]): Message => ({ role: 'assistant', content: blocks });
const user = (...blocks: ContentBlock[]): Message => ({ role: 'user', content: blocks });

describe('parseAskUserInput 唯一归一化与参数判定', () => {
  it('合法多问题：trim、multiSelect 默认 false、options trim', () => {
    const parsed = parseAskUserInput({
      questions: [
        { question: '  用哪个方案？ ', options: [' A ', 'B'] },
        { question: '还有别的要求吗？', multiSelect: true },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.questions).toEqual([
      { question: '用哪个方案？', options: ['A', 'B'], multiSelect: false },
      { question: '还有别的要求吗？', multiSelect: true },
    ]);
  });

  it('非对象 input：失败并附形状提示', () => {
    for (const bad of [null, undefined, 'x', 42, ['questions']]) {
      const parsed = parseAskUserInput(bad);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error).toContain('questions');
    }
  });

  it('questions 空数组 / 缺失：失败', () => {
    expect(parseAskUserInput({ questions: [] }).ok).toBe(false);
    expect(parseAskUserInput({}).ok).toBe(false);
  });

  it('旧顶层单 question 形状不兼容（零迁移）', () => {
    const parsed = parseAskUserInput({ question: '继续吗？', options: ['是', '否'] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('questions 数组');
  });

  it('元素缺 question / 空白 question：失败并指明下标（错误即文档）', () => {
    const parsed = parseAskUserInput({ questions: [{ question: 'ok?' }, { question: '   ' }] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('questions.1.question');
  });

  it('options 含非字符串/空串、multiSelect 非布尔：失败', () => {
    expect(parseAskUserInput({ questions: [{ question: 'q', options: ['a', ''] }] }).ok).toBe(false);
    expect(parseAskUserInput({ questions: [{ question: 'q', options: [1] }] }).ok).toBe(false);
    expect(parseAskUserInput({ questions: [{ question: 'q', multiSelect: 'yes' }] }).ok).toBe(false);
  });
});

describe('inspectLatestToolBatch（严格算法）', () => {
  it('空消息 / 无 assistant：undefined', () => {
    expect(inspectLatestToolBatch([])).toBeUndefined();
    expect(inspectLatestToolBatch([user(text('hi'))])).toBeUndefined();
  });

  it('最新 assistant 是纯文本、较早 call 缺结果 → undefined，绝不向前扫描', () => {
    const messages = [
      asst(tu('call-old', 'ls', {})),   // 较早批次缺结果
      user(text('用户消息')),
      asst(text('纯文本收尾')),
    ];
    expect(inspectLatestToolBatch(messages)).toBeUndefined();
  });

  it('尾部开放批次：calls 逐个带 settled 状态', () => {
    const messages = [
      asst(tu('a', 'ls', {}), tu('b', 'read', {})),
      user(tr('a')),
    ];
    const batch = inspectLatestToolBatch(messages);
    expect(batch?.calls.map(c => [c.id, c.settled])).toEqual([['a', true], ['b', false]]);
  });

  it('最新批次完整、较早 call 缺结果 → 批次全 settled（调用方无事可做）', () => {
    const messages = [
      asst(tu('old', 'ls', {})),        // 较早缺结果：不属于尾部修复域
      user(text('中间消息')),
      asst(tu('new', 'ls', {})),
      user(tr('new')),
    ];
    const batch = inspectLatestToolBatch(messages);
    expect(batch?.calls).toHaveLength(1);
    expect(batch?.calls[0]).toMatchObject({ id: 'new', settled: true });
  });
});

describe('resolveToolUseSettlement（定向计数，原则 4）', () => {
  const base = [asst(tu('x', 'ls', {}))];

  it('恰好一个 call 无结果 → insertable', () => {
    expect(resolveToolUseSettlement(base, 'x')).toBe('insertable');
  });

  it('恰好一个 call 已有结果 → already_settled', () => {
    expect(resolveToolUseSettlement([...base, user(tr('x'))], 'x')).toBe('already_settled');
  });

  it('无对应 call / 重复 call ID → unresolvable', () => {
    expect(resolveToolUseSettlement(base, 'ghost')).toBe('unresolvable');
    const dup = [asst(tu('x', 'ls', {})), user(tr('x')), asst(tu('x', 'ls', {}))];
    expect(resolveToolUseSettlement(dup, 'x')).toBe('unresolvable');
  });
});

describe('getValidPendingAskUser（合法 pending 判据）', () => {
  it('尾部单个合法未配对 ask_user → 命中，id=toolUseId、questions 已归一化', () => {
    const messages = [asst(tu('ask-1'))];
    const pending = getValidPendingAskUser(messages);
    expect(pending?.toolUseId).toBe('ask-1');
    expect(pending?.input.questions).toEqual([{ question: 'Q?', multiSelect: false }]);
  });

  it('批次多 call / 非 ask_user / 已 settled / 参数非法 → 不判 pending', () => {
    expect(getValidPendingAskUser([asst(tu('a'), tu('b', 'ls', {}))])).toBeUndefined();
    expect(getValidPendingAskUser([asst(tu('a', 'ls', {}))])).toBeUndefined();
    expect(getValidPendingAskUser([asst(tu('a')), user(tr('a'))])).toBeUndefined();
    expect(getValidPendingAskUser([asst(tu('a', 'ask_user', { questions: [] }))])).toBeUndefined();
  });

  it('较早损坏同 ID call + 尾部表面合法 ask → 不判 pending，确保结算目标唯一', () => {
    const messages = [
      asst(tu('dup', 'ls', {})),   // 损坏档案：较早同 ID call
      user(tr('dup')),
      asst(tu('dup')),                           // 尾部表面合法 ask_user，ID 撞车
    ];
    expect(getValidPendingAskUser(messages)).toBeUndefined();
  });

  it('尾部纯文本 → 不判 pending', () => {
    expect(getValidPendingAskUser([asst(tu('a')), user(tr('a')), asst(text('done'))])).toBeUndefined();
  });
});

describe('getUnsettledValidAskCalls（ESC 结算目标）', () => {
  it('过滤：只留未结算、名为 ask_user、参数合法、可唯一结算的 call', () => {
    const messages = [
      asst(
        tu('ok-ask'),
        tu('settled-ask'),
        tu('normal', 'ls', {}),
        tu('bad-ask', 'ask_user', { questions: [] }),
      ),
      user(tr('settled-ask')),
    ];
    const batch = inspectLatestToolBatch(messages)!;
    const calls = getUnsettledValidAskCalls(messages, batch);
    expect(calls.map(c => c.id)).toEqual(['ok-ask']);
  });
});

describe('buildToolInterruptionResult（canonical interrupted）', () => {
  it('JSON 形状：status/reason/execution/默认 message 按 execution 区分', () => {
    const notStarted = JSON.parse(buildToolInterruptionResult({ reason: 'user_interrupted', execution: 'not_started' }));
    expect(notStarted).toEqual({
      status: 'interrupted',
      reason: 'user_interrupted',
      execution: 'not_started',
      message: '执行被中断，该工具未启动。',
    });

    const unknown = JSON.parse(buildToolInterruptionResult({ reason: 'recovery_interrupted', execution: 'unknown' }));
    expect(unknown.execution).toBe('unknown');
    expect(unknown.message).toContain('副作用');
  });

  it('自定义 message 覆盖默认文案', () => {
    const r = JSON.parse(buildToolInterruptionResult({
      reason: 'runtime_interrupted', execution: 'unknown', message: '自定义',
    }));
    expect(r.message).toBe('自定义');
  });
});

describe('固定文案常量（错误即文档）', () => {
  it('gate 违规文案含 questions 数组合并指引', () => {
    expect(ASK_USER_GATE_VIOLATION_TEXT).toContain('合并到一次 ask_user 调用的 questions 数组');
    expect(ASK_USER_GATE_VIOLATION_TEXT).toContain('本批所有工具均未执行');
  });
});
