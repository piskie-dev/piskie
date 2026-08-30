/**
 * CommandGate —— 命令 / 文本预览确认（shell 命令、edit 的失败说明）。
 *
 * 与 `DiffGate` 的差别：预览内容**直接铺在门里**（等宽块、上限高度内滚动），
 * 没有「查看详情」按钮——批准要执行什么，必须一眼可见，不该藏在一次点击后面。
 * 选项区与 DiffGate 同构（Allow once / Allow+Auto / 反馈即拒绝）。
 */

import { memo, useCallback, useState } from 'react';
import { Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { composeAttachmentText, useAttachmentDraft } from '../../attachments';
import type { GateCommonProps, GateRequest } from './contract';
import { GateAttachments, GateFeedback, GateHeader, GateOption } from './parts';
import styles from './gates.module.css';

export interface CommandGateProps extends GateCommonProps {
  readonly request: Extract<GateRequest, { kind: 'command' }>;
}

export const CommandGate = memo<CommandGateProps>(
  ({ request, disabled, onDecide, onPreviewImage }) => {
    const { t } = useTranslation();
    const { call } = request;
    const [feedback, setFeedback] = useState('');
    const attachments = useAttachmentDraft();

    const isCommand = call.preview?.type === 'command';
    const content = call.preview?.content ?? '';

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
          icon={<Terminal size={13} />}
          iconTone="success"
          title={<span>{call.preview?.title || call.toolName}</span>}
        />

        {content && (
          <div className={styles.commandBlock}>
            {isCommand && <span className={styles.commandPrompt}>$ </span>}
            {content}
          </div>
        )}

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

CommandGate.displayName = 'CommandGate';
