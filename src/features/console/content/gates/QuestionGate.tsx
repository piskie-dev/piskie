/**
 * QuestionGate —— AI 提问逐项作答。
 *
 * 交互语义：
 * - 选项按 1. 2. 3. 编号成行式按钮，自由输入是最后一个编号项
 * - **单题单选点击即提交**（与审批门一致的"一步到位"）；多选/多题显式提交
 * - Enter 提交（输入法组合中不提交）
 * - 图片附件不按题拆分，随事件一次性附加
 *
 * 提交序列化走 `serializeAskUserAnswers`（格式是与模型的约定，改它等于改协议）。
 */

import React, { memo, useCallback, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AIQuestionItem } from '../../../../../shared/types';
import { serializeAskUserAnswers } from '../../../../utils/askUserAnswer';
import { composeAttachmentText, useAttachmentDraft } from '../../attachments';
import { EMPTY_DRAFT, isComplete, resolveItemAnswer, toggleSelection, type ItemDraft } from './answer';
import type { GateCommonProps, GateRequest } from './contract';
import { GateAttachments, GateFeedback, GateHeader, GateOption } from './parts';
import styles from './gates.module.css';

export interface QuestionGateProps extends GateCommonProps {
  readonly request: Extract<GateRequest, { kind: 'question' }>;
}

interface QuestionItemProps {
  readonly item: AIQuestionItem;
  readonly index: number;
  readonly total: number;
  readonly draft: ItemDraft;
  readonly disabled?: boolean;
  readonly onChange: (draft: ItemDraft) => void;
  /** 单题单选：点击选项直接提交 */
  readonly onPickSubmit?: (answer: string) => void;
  readonly onEnterSubmit: () => void;
  /** 单题时输入行右侧出发送按钮 */
  readonly inlineSubmit?: { readonly enabled: boolean; readonly onSubmit: () => void };
  readonly onPaste: React.ClipboardEventHandler;
}

const QuestionItem = memo<QuestionItemProps>(
  ({ item, index, total, draft, disabled, onChange, onPickSubmit, onEnterSubmit, inlineSubmit, onPaste }) => {
    const { t } = useTranslation();
    const options = item.options ?? [];

    const pick = useCallback(
      (option: string) => {
        if (onPickSubmit && !item.multiSelect) {
          onPickSubmit(option);
          return;
        }
        onChange(toggleSelection(draft, option, item.multiSelect));
      },
      [draft, item.multiSelect, onChange, onPickSubmit],
    );

    const inputPlaceholder = options.length > 0
      ? t('sessionWorkbenchUi.gate.customAnswerPlaceholder')
      : t('sessionWorkbenchUi.gate.answerPlaceholder');

    return (
      <div>
        <div className={styles.questionText}>
          {total > 1 && (
            <span className={styles.questionOrdinal}>
              {t('sessionWorkbenchUi.gate.question')} {index + 1}:
            </span>
          )}
          {item.question}
          {item.multiSelect && (
            <span className={styles.questionHint}>{t('sessionWorkbenchUi.gate.multipleChoice')}</span>
          )}
        </div>

        <div className={`${styles.options} ${styles.optionsScroll}`}>
          {options.map((option, i) => (
            <GateOption
              key={i}
              ordinal={i + 1}
              label={option}
              variant={draft.selected.includes(option) ? 'primary' : 'ghost'}
              disabled={disabled}
              onSelect={() => pick(option)}
            />
          ))}

          <GateFeedback
            ordinal={options.length > 0 ? options.length + 1 : undefined}
            value={draft.custom}
            onChange={(custom) => onChange({ ...draft, custom })}
            onSubmit={inlineSubmit ? inlineSubmit.onSubmit : onEnterSubmit}
            onPaste={onPaste}
            placeholder={inputPlaceholder}
            canSubmit={inlineSubmit ? inlineSubmit.enabled : true}
            disabled={disabled}
            hideSend={!inlineSubmit}
          />
        </div>
      </div>
    );
  },
);

QuestionItem.displayName = 'QuestionItem';

export const QuestionGate = memo<QuestionGateProps>(({ request, disabled, onDecide, onPreviewImage }) => {
  const { t } = useTranslation();
  const { id, items } = request;
  const single = items.length === 1;

  const [drafts, setDrafts] = useState<readonly ItemDraft[]>(() => items.map(() => EMPTY_DRAFT));
  const attachments = useAttachmentDraft();

  const answers = items.map((item, index) => resolveItemAnswer(item, drafts[index] ?? EMPTY_DRAFT));
  const allAnswered = isComplete(answers);

  const submit = useCallback(
    async (override?: readonly string[]) => {
      const final = override ?? answers;
      if (!isComplete(final) || disabled) return;
      onDecide({
        kind: 'answer',
        callId: id,
        answer: composeAttachmentText(
          serializeAskUserAnswers(items as AIQuestionItem[], final as string[]),
          attachments.files,
          attachments.images.length > 0,
        ),
        answers: [...final],
        images: await attachments.imagePayloads(),
      });
      attachments.clear();
    },
    [answers, attachments, disabled, id, items, onDecide],
  );

  const updateDraft = useCallback((index: number, draft: ItemDraft) => {
    setDrafts((previous) => previous.map((candidate, i) => (i === index ? draft : candidate)));
  }, []);

  return (
    <div className={styles.gate} data-disabled={disabled ? 'true' : undefined}>
      <GateHeader
        icon={<CircleHelp size={13} />}
        title={t('sessionWorkbenchUi.gate.aiQuestion')}
        trailing={single ? undefined : t('sessionWorkbenchUi.gate.questionCount', { count: items.length })}
      />

      <div className={styles.questions}>
        {items.map((item, index) => (
          <QuestionItem
            key={index}
            item={item}
            index={index}
            total={items.length}
            draft={drafts[index] ?? EMPTY_DRAFT}
            disabled={disabled}
            onChange={(draft) => updateDraft(index, draft)}
            onPickSubmit={single ? (answer) => void submit([answer]) : undefined}
            onEnterSubmit={() => void submit()}
            inlineSubmit={single ? { enabled: allAnswered, onSubmit: () => void submit() } : undefined}
            onPaste={attachments.handlePaste}
          />
        ))}
      </div>

      <GateAttachments
        images={attachments.images}
        files={attachments.files}
        onRemove={attachments.remove}
        onPreviewImage={onPreviewImage}
      />

      {!single && (
        <div className={styles.submitRow}>
          <button
            type="button"
            className={styles.submit}
            onClick={() => void submit()}
            disabled={!allAnswered || disabled}
          >
            {t('sessionWorkbenchUi.gate.submitAnswer')}
          </button>
        </div>
      )}
    </div>
  );
});

QuestionGate.displayName = 'QuestionGate';
