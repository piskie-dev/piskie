/**
 * DiffGate —— diff 预览确认。
 *
 * 与 `ToolGate` 的差别只在标题行：文件名 + 增删行统计 + 「查看详情」。
 * 三个选项完全同构，所以选项区的结构走同一套 `parts`。
 *
 * 统计口径：`preview.stat.linesAdded/linesDeleted`，为 0 时整段不出。
 */

import { memo, useCallback, useState } from 'react';
import { Eye, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { composeAttachmentText, useAttachmentDraft } from '../../attachments';
import type { GateCommonProps, GateRequest } from './contract';
import { GateAttachments, GateFeedback, GateHeader, GateOption } from './parts';
import styles from './gates.module.css';

export interface DiffGateProps extends GateCommonProps {
  readonly request: Extract<GateRequest, { kind: 'diff' }>;
  readonly onViewDiff: () => void;
}

export const DiffGate = memo<DiffGateProps>(
  ({ request, disabled, onDecide, onViewDiff, onPreviewImage }) => {
    const { t } = useTranslation();
    const { call } = request;
    const [feedback, setFeedback] = useState('');
    const attachments = useAttachmentDraft();

    const filePath = typeof call.params?.path === 'string' ? call.params.path : '';
    const fileName = filePath.split('/').pop() || filePath;
    const added = call.preview?.stat?.linesAdded ?? 0;
    const removed = call.preview?.stat?.linesDeleted ?? 0;

    const canSubmit = (feedback.trim().length > 0 || attachments.hasAttachments) && !disabled;
    const deny = useCallback(async () => {
      if (!canSubmit) return;
      onDecide({
        kind: 'deny',
        callId: call.id,
        feedback: composeAttachmentText(feedback, attachments.files, attachments.images.length > 0),
        images: await attachments.imagePayloads(),
      });
      attachments.clear();
    }, [attachments, call.id, canSubmit, feedback, onDecide]);

    const allow = useCallback(
      () => onDecide({ kind: 'allow', callId: call.id, changeToAuto: false }),
      [call.id, onDecide],
    );
    const allowAuto = useCallback(
      () => onDecide({ kind: 'allow', callId: call.id, changeToAuto: true }),
      [call.id, onDecide],
    );

    return (
      <div className={styles.gate} data-disabled={disabled ? 'true' : undefined}>
        <GateHeader
          icon={<FileText size={13} />}
          iconTone="success"
          title={
            <span title={filePath}>
              {call.toolName}: {fileName}
            </span>
          }
          note={
            added > 0 || removed > 0 ? (
              <span className={styles.diffStat}>
                {added > 0 && <span className={styles.added}>+{added}</span>}
                {added > 0 && removed > 0 && ' / '}
                {removed > 0 && <span className={styles.removed}>-{removed}</span>}
              </span>
            ) : undefined
          }
          action={
            <button type="button" className={styles.ghostButton} onClick={onViewDiff} disabled={disabled}>
              <Eye size={12} />
              <span>{t('sessionWorkbenchUi.gate.viewDetails')}</span>
            </button>
          }
        />

        <div className={styles.options}>
          <div className={styles.actionRow}>
            <GateOption ordinal={1} label={t('sessionWorkbenchUi.gate.allowOnce')} disabled={disabled} onSelect={allow} />
            <GateOption ordinal={2} label={t('sessionWorkbenchUi.gate.allowAndAuto')} disabled={disabled} onSelect={allowAuto} />
          </div>

          <GateAttachments
            images={attachments.images}
            files={attachments.files}
            onRemove={attachments.remove}
            onPreviewImage={onPreviewImage}
          />

          <GateFeedback
            ordinal={3}
            value={feedback}
            onChange={setFeedback}
            onSubmit={deny}
            onPaste={attachments.handlePaste}
            placeholder={t('sessionWorkbenchUi.gate.alternativePlaceholder')}
            canSubmit={canSubmit}
            disabled={disabled}
          />
        </div>
      </div>
    );
  },
);

DiffGate.displayName = 'DiffGate';
