/**
 * ask_user 多问题答案固定序列化格式：
 * 半角冒号、3 空格缩进、\n\n 连接；缺答案兜底空串。
 * 面板层约定（单选=选项原文；多选=选项以"、"连接；自由输入=原文）
 * 在 AIQuestionPanel 的 resolveItemAnswer 中组装后传入本函数。
 */
import { describe, it, expect } from 'vitest';
import { serializeAskUserAnswers } from '../askUserAnswer';
import type { AIQuestionItem } from '../../../shared/types';

describe('serializeAskUserAnswers（固定格式）', () => {
  it('多问题：编号 + 半角冒号 + 3 空格缩进 + 空行连接', () => {
    const questions: AIQuestionItem[] = [
      { question: '用哪个方案？', options: ['A', 'B'], multiSelect: false },
      { question: '要启用哪些能力？', options: ['x', 'y', 'z'], multiSelect: true },
      { question: '其他要求？', multiSelect: false },
    ];
    const out = serializeAskUserAnswers(questions, ['A', 'x、z', '尽快']);
    expect(out).toBe(
      '1. 问题:用哪个方案？\n   回答:A' +
      '\n\n2. 问题:要启用哪些能力？\n   回答:x、z' +
      '\n\n3. 问题:其他要求？\n   回答:尽快',
    );
  });

  it('单问题：无多余空行', () => {
    const out = serializeAskUserAnswers([{ question: '继续吗？', multiSelect: false }], ['是']);
    expect(out).toBe('1. 问题:继续吗？\n   回答:是');
  });

  it('缺答案兜底为空串，不产生 undefined 文本', () => {
    const out = serializeAskUserAnswers(
      [{ question: 'Q1', multiSelect: false }, { question: 'Q2', multiSelect: false }],
      ['只有第一个'],
    );
    expect(out).toContain('2. 问题:Q2\n   回答:');
    expect(out).not.toContain('undefined');
  });
});
