/**
 * ask_user 多问题答案的固定序列化格式（面板提交）
 *
 * 提交时把各问题的答案拼装为一条结构化可读文本——仍是普通用户消息，
 * 不携带任何特殊身份；encodeAnswer 原样进 tool_result，模型对照
 * input.questions 自行解读。单选=选项原文；多选=选项以"、"连接；
 * 自由输入=原文；图片不按问题拆分，随事件 images 字段一次性附加。
 */

import type { AIQuestionItem } from '../../shared/types';

export function serializeAskUserAnswers(questions: AIQuestionItem[], answers: string[]): string {
  return questions
    // i18n-ignore -- serialized ask-user answer protocol
    .map((q, i) => `${i + 1}. 问题:${q.question}\n   回答:${answers[i] ?? ''}`)
    .join('\n\n');
}
