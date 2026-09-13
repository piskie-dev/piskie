/**
 * PlanGate —— 计划审批操作条。
 *
 * **审批对象是计划正文**，正文由流水里的 plan cell 就地渲染（待确认时默认展开），
 * 这里只是底部操作条——不要把正文再抄一份进门里。
 *
 * 计划批准是工作流决定，不修改工具审批模式。
 */

import { memo, useCallback, useRef, useState, type ClipboardEvent } from 'react';
import { ClipboardList, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTimeSeconds } from '../../../../hooks/useTimeSeconds';
import { messageText, presentationFromError, type PresentationText } from '../../../../i18n/presentationText';

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
    const seconds = useTimeSeconds(call.autoApproveAt, 'remaining');
    const [feedback, setFeedback] = useState('');
    const attachments = useAttachmentDraft(undefined, setFeedback);
    const cancelling = useRef(false);
    const [cancellingCountdown, setCancellingCountdown] = useState(false);
    const [cancellationError, setCancellationError] = useState<PresentationText>();
    const actionsDisabled = disabled || attachments.submitting;

    const cancelCountdown = useCallback(async () => {
      if (actionsDisabled || call.autoApproveAt === undefined || cancelling.current) return;
      cancelling.current = true;
      setCancellingCountdown(true);
      setCancellationError(undefined);
      try {
        const ok = await onDecide({ kind: 'cancel-plan-countdown', callId: call.id });
        if (ok === false) setCancellationError(messageText('sessionWorkbenchUi.action.operationFailed'));
      } catch (error) {
        setCancellationError(presentationFromError(error, messageText('sessionWorkbenchUi.action.operationFailed')));
      } finally {
        cancelling.current = false;
        setCancellingCountdown(false);
      }
    }, [call.autoApproveAt, call.id, actionsDisabled, onDecide]);

    const changeFeedback = useCallback((value: string) => {
      if (disabled) return;
      void cancelCountdown();
      setFeedback(value);
    }, [cancelCountdown, disabled]);

    const pasteFeedback = useCallback((event: ClipboardEvent) => {
      if (disabled) return;
      void cancelCountdown();
      attachments.handlePaste(event);
    }, [attachments, cancelCountdown, disabled]);

    const canSubmit = (feedback.trim().length > 0 || attachments.hasAttachments) && !actionsDisabled;

    const deny = useCallback(async () => {
      if (!canSubmit) return;
      setCancellationError(undefined);
      const ok = await attachments.withImages(async (images, files) => onDecide({
        kind: 'deny',
        callId: call.id,
        feedback: composeAttachmentText(feedback, files, Boolean(images?.length)),
        images,
      }));
      if (ok) attachments.clear();
    }, [attachments, call.id, canSubmit, feedback, onDecide]);

    const allow = useCallback(
      () => onDecide({ kind: 'allow', callId: call.id, changeToAuto: false }),
      [call.id, onDecide],
    );
    const reject = useCallback(
      () => onDecide({ kind: 'reject-plan', callId: call.id }),
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
            <GateOption ordinal={1} label={t('sessionWorkbenchUi.gate.approvePlan')} disabled={actionsDisabled} onSelect={allow} />
            <GateOption ordinal={2} label={t('sessionWorkbenchUi.gate.rejectPlan')} disabled={actionsDisabled} onSelect={reject} />
            {call.autoApproveAt !== undefined ? !disabled && (
              <span className={styles.autoApprovalGroup}>
                <span className={styles.autoApprovalCountdown} role="timer">
                  <Timer size={13} aria-hidden />
                  {t('sessionWorkbenchUi.gate.autoApproveSeconds', { seconds })}
                </span>
                <button
                  type="button"
                  className={styles.cancelCountdown}
                  disabled={actionsDisabled || cancellingCountdown}
                  onClick={cancelCountdown}
                >
                  {t('sessionWorkbenchUi.gate.cancelPlanCountdown')}
                </button>
              </span>
            ) : (
              <span className={styles.manualApproval} role="status">
                {t('sessionWorkbenchUi.gate.waitingForPlanApproval')}
              </span>
            )}
          </div>

          <GateAttachments
            images={attachments.images}
            error={cancellationError ?? attachments.error}
            files={attachments.files}
            onRemove={attachments.remove}
            onPreviewImage={onPreviewImage}
          />

          <GateFeedback
            ordinal={3}
            value={feedback}
            onFocus={cancelCountdown}
            onChange={changeFeedback}
            onSubmit={deny}
            onPaste={pasteFeedback}
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
