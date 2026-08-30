/**
 * PlanGate —— 计划审批操作条。
 *
 * **审批对象是计划正文**，正文由流水里的 plan cell 就地渲染（待确认时默认展开），
 * 这里只是底部操作条——不要把正文再抄一份进门里。
 *
 * 计划批准是工作流决定，不修改工具审批模式。
 */

import { memo, useCallback, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { composeAttachmentText, useAttachmentDraft } from '../../attachments';
import type { GateCommonProps, GateRequest } from './contract';
import { GateAttachments, GateFeedback, GateHeader, GateOption } from './parts';
import styles from './gates.module.css';

export interface PlanGateProps extends GateCommonProps {
  readonly request: Extract<GateRequest, { kind: 'plan' }>;
}

export const PlanGate = memo<PlanGateProps>(
  ({ request, disabled, onDecide, onPreviewImage }) => {
    const { t } = useTranslation();
    const { call, taskSummary } = request;
    const [feedback, setFeedback] = useState('');
    const attachments = useAttachmentDraft();

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
    return (
      <div className={styles.gate} data-disabled={disabled ? 'true' : undefined}>
        <GateHeader
          icon={<ClipboardList size={13} />}
          title={t('sessionWorkbenchUi.gate.planTitle')}
          trailing={taskSummary || undefined}
        />

        <div className={styles.options}>
          <div className={styles.actionRow}>
            <GateOption ordinal={1} label={t('sessionWorkbenchUi.gate.approvePlan')} disabled={disabled} onSelect={allow} />
          </div>

          <GateAttachments
            images={attachments.images}
            files={attachments.files}
            onRemove={attachments.remove}
            onPreviewImage={onPreviewImage}
          />

          <GateFeedback
            ordinal={2}
            value={feedback}
            onChange={setFeedback}
            onSubmit={deny}
            onPaste={attachments.handlePaste}
            placeholder={t('sessionWorkbenchUi.gate.planFeedbackPlaceholder')}
            canSubmit={canSubmit}
            disabled={disabled}
          />
        </div>
      </div>
    );
  },
);

PlanGate.displayName = 'PlanGate';
