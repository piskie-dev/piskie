/**
 * 提问作答的纯派生。**不写在组件里**：「单选重复点击取消」「多选把自由输入并进末尾」
 * 这类规则要能单测。提交格式走 `serializeAskUserAnswers`（唯一序列化来源）。
 *
 * 选中集合用 `readonly string[]` 而非 `Set`：门只可能有几个到几十个选项，
 * 数组的顺序稳定（多选答案的拼接顺序 = 点击顺序），
 * 且不可变更新天然适配 React。
 */

import type { AIQuestionItem } from '../../../../../shared/types';

export interface ItemDraft {
  readonly selected: readonly string[];
  readonly custom: string;
}

export const EMPTY_DRAFT: ItemDraft = { selected: [], custom: '' };

/**
 * 单个问题的答案文本：
 * - 多选：已选项以「、」连接，自由输入作为最后一项追加
 * - 单选：**自由输入优先于已选项**（用户敲了字就是要说自己的）
 */
export function resolveItemAnswer(item: AIQuestionItem, draft: ItemDraft): string {
  const custom = draft.custom.trim();

  if (item.multiSelect) {
    const parts = custom ? [...draft.selected, custom] : draft.selected;
    return parts.join('、');
  }

  return custom || draft.selected[0] || '';
}

/** 点击一个选项：多选切换；单选重复点击取消，否则替换 */
export function toggleSelection(draft: ItemDraft, option: string, multiSelect: boolean): ItemDraft {
  if (multiSelect) {
    return {
      ...draft,
      selected: draft.selected.includes(option)
        ? draft.selected.filter((candidate) => candidate !== option)
        : [...draft.selected, option],
    };
  }

  return { ...draft, selected: draft.selected.includes(option) ? [] : [option] };
}

/** 全部问题都有答案才允许提交 */
export function isComplete(answers: readonly string[]): boolean {
  return answers.every((answer) => answer.length > 0);
}
