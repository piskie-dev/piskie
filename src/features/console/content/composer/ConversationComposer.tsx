/**
 * ConversationComposer —— main 与 Worker 共用的会话输入器。
 *
 * 两条构造约束，防的是同一类 bug（外壳的"整块点击即聚焦"抢走浮层焦点、下拉一出现就消失）：
 *
 * - 三个设置控件全部用 `chrome/Popover`（原生 popover，top layer +
 *   light-dismiss + Esc 由浏览器承担），没有"失焦即关"的脆弱链路
 * - "点空白聚焦输入"只挂在 textarea 自己的包装上，不包住控件区
 *
 * 功能面：
 * Enter 发送 / Shift+Enter 换行 / Esc 先退出输入；粘贴图片与文件（缩略图预览、
 * 可移除）；模型 + 思考档位（搜索/分组/budget/mandatory，见 `ModelPicker`）；
 * Agent 模式（仅主 agent，选项来自 Mode Catalog，≤1 项时隐藏）；
 * 审批模式（当前 agent 独立的 Auto/Confirm）；
 * 上下文环与发送/中断共用主动作位；回写逻辑在 `useComposerSettings`。
 *
 * 自动增高走 `field-sizing: content`，不写 JS 测高。
 */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';

import type { ApprovalMode, AgentModeId } from '../../../../../shared/types';
import type { ContextUsage } from '../../../../../shared/types/token';
import { useAttachmentDraft } from '../../attachments';
import { composerDraftKey, useComposerDraft } from '../../data/composer-drafts';
import { ImageThumbnail } from '../ImageThumbnail';
import { Popover } from '../../chrome/Popover';
import { Tooltip } from '../../chrome/Tooltip';
import type { MessagePayload } from '../../data/actions';
import { ContextUsageRing } from './ContextUsageRing';
import {
  resolveComposerMainAction,
  type ComposerPendingAction,
} from './composerMainAction';
import { ModelPicker } from './ModelPicker';
import { useComposerSettings } from './useComposerSettings';
import styles from './conversationComposer.module.css';

// ==================== 通用的药丸下拉（计划 / 审批共用） ====================

interface PillOption<K extends string> {
  readonly key: K;
  readonly label: string;
}

interface PillSelectProps<K extends string> {
  readonly label: string;
  readonly compactIcon: React.ReactNode;
  readonly selectedKey?: K;
  readonly options: readonly PillOption<K>[];
  readonly onSelect: (key: K) => void;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
}

/** 泛型组件走「具名函数 + memo 后断言」的写法（与 `chrome/MenuButton` 同款） */
function PillSelectImpl<K extends string>({
  label,
  compactIcon,
  selectedKey,
  options,
  onSelect,
  disabled,
  ariaLabel,
}: PillSelectProps<K>): React.ReactElement {
    const [open, setOpen] = useState(false);

    return (
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        placement="block-start"
        trigger={
          <button
            type="button"
            className={styles.pill}
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={ariaLabel}
            data-compact="true"
            onClick={() => setOpen((value) => !value)}
          >
            <span className={styles.compactIcon} aria-hidden>{compactIcon}</span>
            <span className={styles.pillSoft}>{label}</span>
            <ChevronDown size={11} className={styles.pillChevron} />
          </button>
        }
      >
        <div className={styles.menu} role="menu">
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={option.key === selectedKey}
              className={styles.option}
              data-selected={option.key === selectedKey ? 'true' : undefined}
              onClick={() => {
                setOpen(false);
                onSelect(option.key);
              }}
            >
              <span className={styles.optionLabel}>{option.label}</span>
              {option.key === selectedKey && <Check size={12} className={styles.optionCheck} />}
            </button>
          ))}
        </div>
      </Popover>
    );
}

const PillSelect = memo(PillSelectImpl) as typeof PillSelectImpl;

// ==================== Agent 模式选项（来自后端 Mode Catalog） ====================

const capitalize = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/** 当前 AgentSpec 的可见模式；失败降级 plan/normal。 */
function useModeOptions(agentSpec: string | undefined, enabled: boolean): readonly string[] {
  const [names, setNames] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const modes = await window.piskie.modes.listAvailable({
          agentSpec: agentSpec || 'director',
        });
        if (alive) setNames(modes.map((item) => item.id));
      } catch {
        if (alive) setNames(['plan', 'normal']);
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentSpec, enabled]);

  return names;
}

// ==================== 组件本体 ====================

export interface ConversationComposerProps {
  readonly agentId: string;
  readonly workerId?: string;
  /** 投递目标显示名（用于 placeholder） */
  readonly targetName: string;
  readonly model: string;
  readonly modeId?: AgentModeId;
  readonly approvalMode: ApprovalMode;
  readonly agentSpec?: string;
  readonly contextUsage?: ContextUsage;
  readonly sourceVersion: number;
  readonly contextViewerEnabled?: boolean;
  readonly canPause: boolean;
  readonly onPreviewImage?: (src: string) => void;
  readonly stopping?: boolean;
  /** 成功才清空草稿和附件。 */
  readonly onSubmit: (payload: MessagePayload) => Promise<boolean>;
  readonly onInterrupt: () => Promise<void>;
}

export const ConversationComposer = memo<ConversationComposerProps>(
  ({
    agentId,
    workerId,
    targetName,
    model,
    modeId,
    approvalMode,
    agentSpec,
    contextUsage,
    sourceVersion,
    contextViewerEnabled,
    canPause,
    onPreviewImage,
    stopping = false,
    onSubmit,
    onInterrupt,
  }) => {
    const { t } = useTranslation();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const draftKey = composerDraftKey(agentId, workerId);
    // 文字与附件共享目标键，切模块/切任务回来仍在，也不会跨目标串稿。
    const [draft, setDraft] = useComposerDraft(draftKey);
    const [pendingAction, setPendingAction] = useState<ComposerPendingAction>(null);
    const attachments = useAttachmentDraft(draftKey);
    const settings = useComposerSettings(agentId, workerId, model);
    const modeIds = useModeOptions(agentSpec, !workerId);
    const hasAttachments = attachments.hasAttachments;
    const mainAction = resolveComposerMainAction(
      Boolean(draft.trim()) || hasAttachments,
      canPause,
      stopping,
      pendingAction,
    );
    const controlsDisabled = stopping || pendingAction !== null;
    const actionLabel = mainAction.kind === 'interrupt'
      ? workerId
        ? t('sessionWorkbenchUi.composer.interruptWorker')
        : t('sessionWorkbenchUi.composer.interruptRun')
      : t('sessionWorkbenchUi.composer.send');

    const submit = useCallback(async () => {
      if (stopping || pendingAction !== null || (!draft.trim() && !attachments.hasAttachments)) return;
      setPendingAction('send');
      try {
        const ok = await onSubmit({
          text: draft,
          images: await attachments.imagePayloads(),
          files: attachments.files.map(({ name, path }) => ({ name, path })),
        });
        if (ok) {
          setDraft('');
          attachments.clear();
        }
      } finally {
        setPendingAction(null);
      }
    }, [attachments, draft, onSubmit, pendingAction, setDraft, stopping]);

    const interrupt = useCallback(async () => {
      if (stopping || !canPause || pendingAction !== null) return;
      setPendingAction('interrupt');
      try {
        await onInterrupt();
      } finally {
        setPendingAction(null);
      }
    }, [canPause, onInterrupt, pendingAction, stopping]);

    const onKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void submit();
          return;
        }
        // Esc 链的第一级：焦点在输入框里时先退出输入，再按一次才回主会话 tab
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          textareaRef.current?.blur();
        }
      },
      [submit],
    );

    const approvalOptions: readonly PillOption<ApprovalMode>[] = [
      { key: 'auto', label: t('sessionWorkbenchUi.composer.automaticApproval') },
      { key: 'confirm', label: t('sessionWorkbenchUi.composer.confirmApproval') },
    ];

    const modeLabel = (name: string): string => {
      if (name === 'normal') return t('sessionWorkbenchUi.composer.modeNormal');
      if (name === 'plan') return t('sessionWorkbenchUi.composer.modePlan');
      if (name === 'browser-skill') return t('sessionWorkbenchUi.composer.modeBrowserSkill');
      return capitalize(name);
    };

    return (
      <div className={styles.composer}>
        {hasAttachments && (
          <div className={styles.attachments}>
            {attachments.images.map((image) => (
              <div key={image.id} className={styles.thumbWrap}>
                <ImageThumbnail
                  resource={{ kind: 'preview-url', url: image.previewUrl }}
                  alt={t('sessionWorkbenchUi.composer.imageAttachment')}
                  className={styles.thumb}
                  onPreview={onPreviewImage}
                />
                <button
                  type="button"
                  className={styles.thumbRemove}
                  onClick={() => attachments.remove(image.id)}
                  aria-label={t('sessionWorkbenchUi.composer.removeImage')}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {attachments.files.map((file) => (
              <div key={file.id} className={styles.fileChip} title={file.path}>
                <FileText size={12} />
                <span className={styles.fileName}>{file.name}</span>
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={() => attachments.remove(file.id)}
                  aria-label={t('sessionWorkbenchUi.composer.removeFile')}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 点空白聚焦只包 textarea 区，**不包工具行** —— 包整壳会在点下拉时冒泡抢焦点、下拉即关 */}
        <div className={styles.inputZone} onClick={() => textareaRef.current?.focus()}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={attachments.handlePaste}
            placeholder={t('sessionWorkbenchUi.composer.instructionPlaceholder', { name: targetName })}
            rows={1}
            disabled={stopping}
          />
        </div>

        <div className={styles.toolbar}>
          <ModelPicker
            modelGroups={settings.modelGroups}
            model={model}
            onModelChange={settings.onModelChange}
            onReasoningChange={settings.onReasoningChange}
            disabled={controlsDisabled}
          />

          {/* 顶层模式仅主 Agent 有；不具备选择空间时隐藏。 */}
          {!workerId && modeIds.length > 1 && (
            <PillSelect
              label={modeLabel(modeId || 'normal')}
              compactIcon={<Bot size={12} />}
              selectedKey={modeId || 'normal'}
              options={modeIds.map((name) => ({ key: name, label: modeLabel(name) }))}
              onSelect={(key) => void settings.onModeChange(key as AgentModeId)}
              disabled={controlsDisabled}
              ariaLabel={t('sessionWorkbenchUi.composer.agentMode')}
            />
          )}

          <PillSelect
            label={approvalMode === 'auto'
              ? t('sessionWorkbenchUi.composer.automaticApproval')
              : t('sessionWorkbenchUi.composer.confirmApproval')}
            compactIcon={<ShieldCheck size={12} />}
            selectedKey={approvalMode}
            options={approvalOptions}
            onSelect={(key) => void settings.onApprovalModeChange(key)}
            disabled={controlsDisabled}
            ariaLabel={t('sessionWorkbenchUi.composer.approvalMode')}
          />

          <span className={styles.spacer} />

          <ContextUsageRing
            usage={contextUsage}
            agentId={workerId ?? agentId}
            sourceVersion={sourceVersion}
            viewerEnabled={contextViewerEnabled}
          />

          <Tooltip
            title={actionLabel}
            enterDelay={100}
          >
            <button
              type="button"
              className={styles.mainAction}
              onClick={mainAction.kind === 'interrupt' ? () => void interrupt() : () => void submit()}
              disabled={mainAction.disabled}
              aria-label={actionLabel}
            >
              {mainAction.kind === 'sending' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : mainAction.kind === 'interrupt' ? (
                <Square size={11} fill="currentColor" />
              ) : (
                <ArrowUp size={14} />
              )}
            </button>
          </Tooltip>
        </div>
      </div>
    );
  },
);

ConversationComposer.displayName = 'ConversationComposer';
