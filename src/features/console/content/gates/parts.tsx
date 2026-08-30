/**
 * 审批门共用原语。
 *
 * 四个门共用「标题行 / 编号按钮 / 附件 chip / 反馈输入行」这一套结构：
 * 同一处修一次，四个门同时对齐。
 *
 * 共用的是**结构**，不是策略：`PlanGate` 在 auto 模式下藏掉「切换自动模式」
 * 并把输入项从 3 号改为 2 号，另外三个门不会。
 *
 * 这里只有呈现，没有决策：谁能提交、提交什么由各门自己决定。
 */

import React, { memo, useCallback } from 'react';
import { SendHorizonal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AttachmentFile, AttachmentImage } from '../../attachments';
import { ImageThumbnail } from '../ImageThumbnail';
import styles from './gates.module.css';

export type GateImage = { readonly data: string; readonly media_type: string };

// ==================== 标题行 ====================

export interface GateHeaderProps {
  readonly icon?: React.ReactNode;
  readonly iconTone?: 'primary' | 'success' | 'muted';
  readonly title: React.ReactNode;
  /** 紧跟标题的次要说明（工具描述） */
  readonly note?: React.ReactNode;
  /** 靠右的次要信息（计划摘要、题数、diff 统计…） */
  readonly trailing?: React.ReactNode;
  /** 靠右的操作（查看详情） */
  readonly action?: React.ReactNode;
}

export const GateHeader = memo<GateHeaderProps>(({ icon, iconTone = 'primary', title, note, trailing, action }) => (
  <div className={styles.header}>
    {/* 等待指示灯：门在场 = 系统停着等人，这枚 waiting 色脉冲是全门的状态锚点 */}
    <span className={styles.pulse} aria-hidden />
    {icon && (
      <span className={styles.headerIcon} data-tone={iconTone === 'primary' ? undefined : iconTone}>
        {icon}
      </span>
    )}
    <span className={styles.headerTitle}>{title}</span>
    {note && <span className={styles.headerNote}>{note}</span>}
    {trailing && <span className={styles.headerTrailing}>{trailing}</span>}
    {action}
  </div>
));

GateHeader.displayName = 'GateHeader';

// ==================== 编号选项 ====================

export interface GateOptionProps {
  readonly ordinal?: number;
  readonly label: React.ReactNode;
  readonly variant?: 'primary' | 'ghost';
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export const GateOption = memo<GateOptionProps>(({ ordinal, label, variant = 'ghost', disabled, onSelect }) => (
  <button
    type="button"
    className={styles.option}
    data-variant={variant === 'primary' ? 'primary' : undefined}
    disabled={disabled}
    onClick={onSelect}
  >
    {/* 序号即键位：键帽徽章，不再拼进文案字符串 */}
    {ordinal !== undefined && <kbd className={styles.key}>{ordinal}</kbd>}
    <span className={styles.optionLabel}>{label}</span>
  </button>
));

GateOption.displayName = 'GateOption';

// ==================== 反馈 / 自由输入行 ====================

export interface GateFeedbackProps {
  /** 与上方选项连续的键位序号；不传则不出键帽 */
  readonly ordinal?: number;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onPaste: React.ClipboardEventHandler;
  readonly placeholder: string;
  readonly canSubmit: boolean;
  readonly disabled?: boolean;
  /** 多题模式下发送按钮收到底部统一提交，这里不出 */
  readonly hideSend?: boolean;
}

export const GateFeedback = memo<GateFeedbackProps>(
  ({ ordinal, value, onChange, onSubmit, onPaste, placeholder, canSubmit, disabled, hideSend }) => {
    const { t } = useTranslation();
    const onKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        // 输入法组合中的回车不提交
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (canSubmit) onSubmit();
        }
      },
      [canSubmit, onSubmit],
    );

    return (
      <div className={styles.feedback}>
        {ordinal !== undefined && <kbd className={styles.key}>{ordinal}</kbd>}
        <input
          type="text"
          className={styles.feedbackInput}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          disabled={disabled}
        />
        {!hideSend && (
          <button
            type="button"
            className={styles.send}
            onClick={onSubmit}
            disabled={!canSubmit}
            aria-label={t('sessionWorkbenchUi.gate.send')}
          >
            <SendHorizonal size={12} />
          </button>
        )}
      </div>
    );
  },
);

GateFeedback.displayName = 'GateFeedback';

// ==================== 附件预览 ====================

export interface GateAttachmentsProps {
  readonly images: readonly AttachmentImage[];
  readonly files: readonly AttachmentFile[];
  readonly onRemove: (id: string) => void;
  readonly onPreviewImage?: (src: string) => void;
}

export const GateAttachments = memo<GateAttachmentsProps>(
  ({ images, files, onRemove, onPreviewImage }) => {
    const { t } = useTranslation();
    if (images.length === 0 && files.length === 0) return null;

    return (
      <div className={styles.attachments}>
        {images.map((image) => (
          <span key={image.id} className={styles.chip}>
            <ImageThumbnail
              resource={{ kind: 'preview-url', url: image.previewUrl }}
              className={styles.chipThumb}
              alt={t('sessionWorkbenchUi.gate.attachmentImage')}
              onPreview={onPreviewImage}
            />
            <span className={styles.chipName}>{t('sessionWorkbenchUi.gate.image')}</span>
            <button type="button" className={styles.chipRemove} onClick={() => onRemove(image.id)}>
              <X size={9} />
            </button>
          </span>
        ))}
        {files.map((file) => (
          <span key={file.id} className={styles.chip} title={file.path}>
            <span className={styles.chipName}>{file.name}</span>
            <button type="button" className={styles.chipRemove} onClick={() => onRemove(file.id)}>
              <X size={9} />
            </button>
          </span>
        ))}
      </div>
    );
  },
);

GateAttachments.displayName = 'GateAttachments';
