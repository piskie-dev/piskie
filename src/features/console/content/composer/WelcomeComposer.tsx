/**
 * WelcomeComposer —— 空态的输入器。
 *
 * 结构：`composerFrame`(30px) → `composerShell`(28px, min-h 112) → 附件 / textarea / toolbar，
 * 样式在 `welcomeComposer.module.css`。聚焦时外框跑 8 色彩虹渐变 + 呼吸投影
 * （`welcomeFlow` / `welcomeBreathActive`）。
 *
 * 三个控件（模型 / 计划模式 / 审批模式）与 dock 共用；
 * 空态额外有**工作区选择**与**浏览器环境选择**，它们只在空态出现
 * ——启动后这两项已经固定在 runConfig 里，不再可改。
 *
 * textarea 自增高用 `field-sizing`，不做 JS 测量。
 */

import React, { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, FolderOpen, Image as ImageIcon, SendHorizonal, X } from 'lucide-react';

import type { ApprovalMode, AgentModeId } from '../../../../../shared/types';
import type { ReasoningSelection } from '../../../../../shared/types/reasoning';
import ApprovalModeSelector from '../../../../components/agent-params/ApprovalModeSelector';
import ModeSelector from '../../../../components/agent-params/ModeSelector';
import BrowserEnvironmentBindingPicker from '../../../../components/BrowserEnvironmentBindingPicker';
import { ModelReasoningControl } from '../../../../components/shared';
import { getAvailableModelOptions, useInferenceStore } from '../../../../store/inferenceStore';
import type { AttachmentFile, AttachmentImage } from '../../attachments';
import type { PresentationText } from '../../../../i18n/presentationText';
import { Popover } from '../../chrome/Popover';
import { AttachmentThumbnail, AttachmentError } from '../../attachments/AttachmentThumbnail';
import { SkillTags } from '../SkillTags';
import { SkillPicker } from './SkillPicker';
import { useSkillComposer } from './useSkillComposer';
import styles from './welcomeComposer.module.css';

export interface WelcomeComposerProps {
  readonly value: string;
  readonly skills: readonly string[];
  readonly onSkillsChange: (skills: readonly string[]) => void;
  readonly draftIdentity: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onPaste: React.ClipboardEventHandler;
  readonly placeholder: string;
  readonly sending?: boolean;
  readonly error?: PresentationText;
  readonly images: readonly AttachmentImage[];
  readonly files: readonly AttachmentFile[];
  readonly onRemoveAttachment: (id: string) => void;
  readonly onPreviewImage?: (src: string) => void;
  readonly model?: string;
  readonly onModelChange: (model: string) => void;
  readonly modeId: AgentModeId;
  readonly onModeChange: (mode: AgentModeId) => void;
  readonly approvalMode: ApprovalMode;
  readonly onApprovalModeChange: (mode: ApprovalMode) => void;
  readonly workspaceLabel: string;
  readonly workspacePath?: string;
  readonly onSelectWorkspace: () => void;
  readonly onUseDefaultWorkspace: () => void;
  readonly environmentIds: readonly string[];
  readonly onEnvironmentIdsChange: (environmentIds: string[]) => void;
  /** Runtime chrome above the input; never becomes conversation content. */
  readonly statusSlot?: React.ReactNode;
}

export const WelcomeComposer = memo<WelcomeComposerProps>(
  ({
    value,
    skills,
    onSkillsChange,
    draftIdentity,
    onChange,
    onSubmit,
    onPaste,
    placeholder,
    sending,
    error,
    images,
    files,
    onRemoveAttachment,
    onPreviewImage,
    model,
    onModelChange,
    modeId,
    onModeChange,
    approvalMode,
    onApprovalModeChange,
    workspaceLabel,
    workspacePath,
    onSelectWorkspace,
    onUseDefaultWorkspace,
    environmentIds,
    onEnvironmentIdsChange,
    statusSlot,
  }) => {
    const { t } = useTranslation();
    const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
    const inferenceConfig = useInferenceStore((store) => store.config);
    const aiModels = useInferenceStore((store) => store.models.ai);
    const availableAiTargets = useInferenceStore((store) => store.availableTargets.ai);
    const updateModelReasoningDefault = useInferenceStore((store) => store.updateModelReasoningDefault);
    const modelGroups = React.useMemo(
      () => getAvailableModelOptions(inferenceConfig, aiModels, availableAiTargets, 'ai'),
      [aiModels, availableAiTargets, inferenceConfig],
    );

    const skillComposer = useSkillComposer({ value, onChange, skills, onSkillsChange, workspace: workspacePath, draftIdentity });
    const { onKeyDown: onSkillKeyDown } = skillComposer;
    const hasAttachments = images.length > 0 || files.length > 0;
    const attachmentCount = images.length + files.length;
    const canSend = (value.trim().length > 0 || hasAttachments || skills.length > 0) && !sending;

    const onKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (onSkillKeyDown(event)) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSubmit();
        }
      },
      [onSubmit, onSkillKeyDown],
    );

    const onReasoningChange = useCallback(
      async (selection?: ReasoningSelection) => {
        if (!model || !selection) return;
        await updateModelReasoningDefault(model, selection);
      },
      [model, updateModelReasoningDefault],
    );

    /** 点空白处聚焦；点控件不抢焦点 */
    const focusInput = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest('button, textarea, select, [data-composer-control="true"]')) return;
      event.currentTarget.querySelector('textarea')?.focus();
    }, []);

    return (
      <div className={styles.composerBlock}>
        {statusSlot}
        <div ref={skillComposer.anchorRef} className={styles.composerFrame} onClick={focusInput}>
          <SkillPicker controller={skillComposer} />
          <div className={styles.composerShell}>
            <AttachmentError error={error} />
            {skills.length > 0 && (
              <div className={styles.attachments}>
                <SkillTags skills={skills} options={skillComposer.options}
                  onRemove={(name) => onSkillsChange(skills.filter((skill) => skill !== name))} />
              </div>
            )}
            {hasAttachments && (
              <div className={styles.attachments}>
                {images.map((image) => (
                  <div key={image.id} className={styles.imageThumb}>
                    <AttachmentThumbnail
                      image={image}
                      alt={t('sessionWorkbenchUi.composer.imagePreview')}
                      className={styles.imageThumbPreview}
                      onPreview={onPreviewImage}
                    />
                    <button
                      type="button"
                      className={styles.removeButton}
                      aria-label={t('sessionWorkbenchUi.composer.remove')}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveAttachment(image.id);
                      }}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
                {files.map((file) => (
                  <div key={file.id} className={styles.fileChip}>
                    <FileText size={13} />
                    <span className={styles.fileName}>{file.name}</span>
                    <button
                      type="button"
                      className={styles.removeButton}
                      aria-label={t('sessionWorkbenchUi.composer.remove')}
                      onClick={() => onRemoveAttachment(file.id)}
                    >
                      <X size={9} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className={styles.textareaWrap}>
              <textarea
                ref={skillComposer.textareaRef}
                {...skillComposer.textareaProps}
                aria-label={placeholder}
                className={styles.textarea}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={onKeyDown}
                onPaste={(event) => { skillComposer.onPasteOrDrop(); onPaste(event); }}
                placeholder={placeholder}
                rows={1}
              />
            </div>

            <div className={styles.toolbar}>
              <div className={styles.toolbarGroup}>
                <div className={styles.primaryControls}>
                  <div className={styles.modelReasoningSlot} data-composer-control="true">
                    <ModelReasoningControl
                      modelGroups={modelGroups}
                      model={model}
                      onModelChange={onModelChange}
                      onReasoningChange={onReasoningChange}
                      variant="full"
                    />
                  </div>

                  <div className={styles.controlPill} data-composer-control="true">
                    <ModeSelector mode={modeId} onChange={onModeChange} />
                  </div>

                  <div className={styles.controlPill} data-composer-control="true">
                    <ApprovalModeSelector mode={approvalMode} onChange={onApprovalModeChange} />
                  </div>
                </div>

                <div className={styles.secondaryControls}>
                  <Popover
                    open={workspaceOpen}
                    onClose={() => setWorkspaceOpen(false)}
                    trigger={
                      <button
                        type="button"
                        className={`${styles.controlPill} ${styles.workspaceButton}`}
                        data-composer-control="true"
                        title={workspacePath || t('sessionWorkbenchUi.shell.defaultWorkspace')}
                        onClick={() => setWorkspaceOpen((open) => !open)}
                      >
                        <FolderOpen size={14} className={styles.workspaceIcon} />
                        <span className={styles.workspaceButtonText}>{workspaceLabel}</span>
                      </button>
                    }
                  >
                    <div className={styles.workspaceMenu}>
                      <button
                        type="button"
                        className={styles.workspaceMenuItem}
                        onClick={() => {
                          setWorkspaceOpen(false);
                          onSelectWorkspace();
                        }}
                      >
                        {t('sessionWorkbenchUi.composer.chooseFolder')}
                      </button>
                      <button
                        type="button"
                        className={styles.workspaceMenuItem}
                        onClick={() => {
                          setWorkspaceOpen(false);
                          onUseDefaultWorkspace();
                        }}
                      >
                        {t('sessionWorkbenchUi.composer.useDefaultWorkspace')}
                      </button>
                    </div>
                  </Popover>

                  <div className={`${styles.controlPill} ${styles.resourceControl}`} data-composer-control="true">
                    <BrowserEnvironmentBindingPicker
                      value={environmentIds}
                      onChange={onEnvironmentIdsChange}
                      compact
                    />
                  </div>

                  {hasAttachments && (
                    <div className={styles.attachmentPill} data-composer-control="true">
                      <ImageIcon size={13} />
                      <span>{attachmentCount}</span>
                    </div>
                  )}
                </div>
              </div>

              <button
                type="button"
                className={`${styles.sendButton} ${canSend ? styles.sendEnabled : ''}`}
                onClick={onSubmit}
                disabled={!canSend}
                aria-label={t('sessionWorkbenchUi.composer.send')}
              >
                <SendHorizonal size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

WelcomeComposer.displayName = 'WelcomeComposer';
