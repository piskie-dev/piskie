/**
 * ToolGate —— 工具调用确认。
 *
 * 所有工具共享三个选项：允许本次 / 允许并切当前 Agent 为 Auto / 拒绝并反馈。
 *
 * 工具类别不做颜色编码：类别不是**状态**，用颜色编码它会和状态色系（status-*）
 * 打架——类别着色不属于语义，因此图标区分、颜色统一。
 */

import { memo, useCallback, useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { composeAttachmentText, useAttachmentDraft } from '../../attachments';
import type { GateCommonProps, GateRequest } from './contract';
import { GateAttachments, GateFeedback, GateHeader, GateOption } from './parts';
import styles from './gates.module.css';

export interface ToolGateProps extends GateCommonProps {
  readonly request: Extract<GateRequest, { kind: 'tool' }>;
}

export const ToolGate = memo<ToolGateProps>(({ request, disabled, onDecide, onPreviewImage }) => {
  const { t } = useTranslation();
  const { call } = request;
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
  const allowAuto = useCallback(
    () => onDecide({ kind: 'allow', callId: call.id, changeToAuto: true }),
    [call.id, onDecide],
  );
  return (
    <div className={styles.gate} data-disabled={disabled ? 'true' : undefined}>
      <GateHeader icon={<ShieldQuestion size={13} />} title={call.toolName} note={call.description} />

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
});

ToolGate.displayName = 'ToolGate';
