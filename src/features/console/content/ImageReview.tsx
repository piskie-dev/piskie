/**
 * ImageReview —— 生图审核内联。
 *
 * 形态：贴在流水尾部、composer 之上的审核区。与 `Gate` 同族——"有个东西等你决定"——
 * 但**与审批门可并存**（生图审核期间照样可能有工具待确认），所以不走 `Panel` 的
 * `gate` 槽的互斥语义。
 *
 * 状态呈现是本地 `[data-tone]` 三档，不污染 agent 状态色系，也不往
 * `AgentStatusIndicator` 注册 `img_*` 状态（那类注册是模块导入即写全局注册表的副作用）。
 *
 * 交互语义：确认全部 / 进入编辑 / 多选 + 提示词重生成 / 删除单张 / 取消 /
 * 切换模型（仅影响本节点后续重生成）/ preview 倒计时 / 不支持 img2img 的模型禁止粘贴图片。
 * IPC 失败一律回显（不得忽略 `success: false`），回显落在审核区内的一行 notice
 * ——错误该留在出错的地方。
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ImageIcon, Loader2, SendHorizonal, Trash2, X, ZoomIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ImageItemPublicState, ImageNodePublicState } from '../../../../shared/types';
import { useTimeSeconds } from '../../../hooks/useTimeSeconds';
import {
  messageText,
  presentationFromError,
  resolvePresentationText,
  type PresentationText,
} from '../../../i18n/presentationText';
import { composeAttachmentText, useAttachmentDraft } from '../attachments';
import {
  formatModelReference,
  getAvailableModelOptions,
  parseModelReference,
  useInferenceStore,
} from '../../../store/inferenceStore';
import { Select } from '../../../components/shared/Select';
import { GateAttachments } from './gates/parts';
import type { ActionTarget } from '../data/actions';
import styles from './ImageReview.module.css';
import { useImagePreviewUrl } from './useImagePreviewUrl';

type NodeStatus = ImageNodePublicState['status'];

const STATUS_KEY: Record<string, string> = {
  generating: 'sessionWorkbenchUi.imageReview.statusGenerating',
  preview: 'sessionWorkbenchUi.imageReview.statusPending',
  pending_approval: 'sessionWorkbenchUi.imageReview.statusEditing',
  regenerating: 'sessionWorkbenchUi.imageReview.statusRevising',
  committing: 'sessionWorkbenchUi.imageReview.statusSubmitting',
  approved: 'sessionWorkbenchUi.imageReview.statusConfirmed',
  partial: 'sessionWorkbenchUi.imageReview.statusPartial',
  failed: 'sessionWorkbenchUi.imageReview.statusFailed',
  cancelled: 'sessionWorkbenchUi.imageReview.statusCancelled',
};

/** 四档语气；色值由 CSS 按 tone 取，组件里不出现颜色 */
function statusTone(status: NodeStatus): 'active' | 'waiting' | 'error' | 'done' {
  if (status === 'preview' || status === 'pending_approval' || status === 'partial') return 'waiting';
  if (status === 'failed') return 'error';
  if (status === 'approved' || status === 'cancelled') return 'done';
  return 'active';
}

/** 预览源口径与 `Artifacts` 一致（同一份判据，两处消费） */
function previewSourcePath(status: NodeStatus, image: ImageItemPublicState): string | undefined {
  if (image.status !== 'completed') return undefined;
  if (status === 'approved') return image.outputPath;
  if (
    status === 'preview' ||
    status === 'pending_approval' ||
    status === 'regenerating' ||
    status === 'committing'
  ) {
    return image.candidatePath;
  }
  return undefined;
}

/**
 * preview 态的倒计时秒数；非 preview 或无 deadline 时为 null。
 */
function useCountdown(node: ImageNodePublicState, active: boolean): number | null {
  const deadline = node.previewDeadline;
  const counting = active && !!deadline;
  const remaining = useTimeSeconds(counting ? deadline : undefined, 'remaining');

  if (!counting) return null;
  return remaining;
}

// ==================== 单张图片 ====================

interface TileProps {
  readonly image: ImageItemPublicState;
  readonly nodeStatus: NodeStatus;
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly onDelete: () => void;
  readonly onPreview?: (src: string) => void;
}

const Tile = memo<TileProps>(
  ({ image, nodeStatus, selectable, selected, onToggle, onDelete, onPreview }) => {
    const { t } = useTranslation();
    const dataUrl = useImagePreviewUrl(
      previewSourcePath(nodeStatus, image),
      image.version,
    );

    return (
      <div
        className={styles.tile}
        title={image.prompt}
        data-selectable={selectable ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        onClick={selectable ? onToggle : undefined}
      >
        {dataUrl ? (
          <img src={dataUrl} className={styles.thumb} alt={image.prompt || t('sessionWorkbenchUi.imageReview.title')} />
        ) : image.status === 'generating' ? (
          // Gemini 式生成占位：灰底 + 白色波带斜向流过（样式见 .waves；无 spinner，波纹即状态）
          <span className={styles.waves} aria-hidden="true" />
        ) : image.status === 'error' ? (
          <span className={styles.tileError}>{image.error || t('sessionWorkbenchUi.imageReview.generationFailed')}</span>
        ) : (
          <span className={styles.placeholder}>
            <ImageIcon size={16} />
          </span>
        )}

        {selectable && (
          <>
            <span className={styles.tileMark} aria-hidden="true">
              <Check size={9} strokeWidth={3} />
            </span>
            <button
              type="button"
              className={styles.tileAction}
              aria-label={t('sessionWorkbenchUi.imageReview.deleteImage')}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 size={10} />
            </button>
          </>
        )}

        {dataUrl && (
          <button
            type="button"
            className={styles.zoom}
            aria-label={t('sessionWorkbenchUi.imageReview.enlarge')}
            onClick={(event) => {
              event.stopPropagation();
              onPreview?.(dataUrl);
            }}
          >
            <ZoomIn size={10} />
          </button>
        )}
      </div>
    );
  },
);

Tile.displayName = 'ImageReviewTile';

// ==================== 审核区 ====================

export interface ImageReviewProps {
  readonly target: ActionTarget;
  readonly node: ImageNodePublicState;
  readonly onPreviewImage?: (src: string) => void;
}

export const ImageReview = memo<ImageReviewProps>(({ target, node, onPreviewImage }) => {
  const { t } = useTranslation();
  const { id: nodeId, status, images } = node;
  const runtimeId = target.workerId ?? target.agentId;

  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<PresentationText | null>(null);
  const [targetOverride, setTargetOverride] = useState<{
    sourceReference: string;
    target: ImageNodePublicState['target'];
  }>();

  const attachments = useAttachmentDraft();
  const noticeText = notice
    ? resolvePresentationText(notice, (key, values) => t(key, values))
    : null;

  const inferenceConfig = useInferenceStore((store) => store.config);
  const imageModels = useInferenceStore((store) => store.models.image);
  const availableImageTargets = useInferenceStore((store) => store.availableTargets.image);
  const refreshInference = useInferenceStore((store) => store.refresh);
  const sourceTargetReference = formatModelReference(node.target);
  const selectedTarget = targetOverride?.sourceReference === sourceTargetReference
    ? targetOverride.target
    : node.target;

  useEffect(() => {
    if (!inferenceConfig) void refreshInference();
  }, [inferenceConfig, refreshInference]);

  const editable = status === 'pending_approval';
  const busy = status === 'regenerating' || status === 'committing';
  const canCancel = status === 'preview' || status === 'pending_approval';
  const countdown = useCountdown(node, status === 'preview');
  const completed = images.filter((image) => image.status === 'completed').length;

  // 原生 select 拉平统一 Inference 的 provider 分组，并保留 provider 名称作为 hint。
  const modelOptions = useMemo(() => {
    return getAvailableModelOptions(inferenceConfig, imageModels, availableImageTargets, 'image')
      .flatMap((group) => group.options.map((option) => ({
        value: option.value,
        label: option.label,
        hint: group.label,
        definition: option.definition,
      })));
  }, [availableImageTargets, imageModels, inferenceConfig]);

  const modelValue = formatModelReference(selectedTarget);

  const supportsEditing = useMemo(() => {
    return modelOptions.find((option) => option.value === modelValue)?.definition.capabilities.edit ?? false;
  }, [modelOptions, modelValue]);

  /**
   * 粘贴前校验：不支持 img2img 的模型禁止粘图（主进程仍二次校验）。
   * 不达标不弹 toast，回显到审核区的 notice 行。
   */
  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      const items = event.clipboardData?.items;
      const hasImage =
        !!items &&
        Array.from(items).some((item) => item.kind === 'file' && item.type.startsWith('image/'));

      if (hasImage && !supportsEditing) {
        event.preventDefault();
        setNotice(messageText('sessionWorkbenchUi.imageReview.editUnsupported'));
        return;
      }
      attachments.handlePaste(event);
    },
    [attachments, supportsEditing],
  );

  const runAction = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    try {
      await action();
      setNotice(null);
      return true;
    } catch (error) {
      setNotice(presentationFromError(
        error,
        messageText('sessionWorkbenchUi.imageReview.operationFailed'),
      ));
      return false;
    }
  }, []);

  const approve = useCallback(async () => {
    await runAction(() => window.piskie.agents.images.approve(runtimeId, nodeId));
  }, [nodeId, runAction, runtimeId]);

  const cancel = useCallback(async () => {
    await runAction(() => window.piskie.agents.images.cancel(runtimeId, nodeId));
  }, [nodeId, runAction, runtimeId]);

  const enterEdit = useCallback(async () => {
    await runAction(() => window.piskie.agents.images.enterEdit(runtimeId, nodeId));
  }, [nodeId, runAction, runtimeId]);

  const deleteImage = useCallback(
    async (imageId: string) => {
      await runAction(() => window.piskie.agents.images.delete(runtimeId, nodeId, imageId));
    },
    [nodeId, runAction, runtimeId],
  );

  const changeModel = useCallback(
    async (value: string) => {
      const target = parseModelReference(value);
      if (!target) {
        setNotice(messageText('sessionWorkbenchUi.imageReview.invalidModel'));
        return;
      }
      setTargetOverride({ sourceReference: sourceTargetReference, target });
      const changed = await runAction(() => (
        window.piskie.agents.images.changeModel(runtimeId, nodeId, target)
      ));
      if (!changed) setTargetOverride(undefined);
    },
    [nodeId, runAction, runtimeId, sourceTargetReference],
  );

  const regenerate = useCallback(async () => {
    if ((!instruction.trim() && !attachments.hasAttachments) || selectedIds.length === 0 || sending) return;
    setSending(true);
    try {
      const succeeded = await runAction(async () => {
        await window.piskie.agents.images.regenerate({
          agentId: runtimeId,
          nodeId,
          imageIds: [...selectedIds],
          instruction: composeAttachmentText(
            instruction,
            attachments.files,
            attachments.images.length > 0,
          ),
          target: selectedTarget,
          images: await attachments.imagePayloads(),
        });
      });
      if (succeeded) {
        setInstruction('');
        setSelectedIds([]);
        attachments.clear();
      }
    } finally {
      setSending(false);
    }
  }, [
    attachments,
    instruction,
    nodeId,
    runAction,
    runtimeId,
    selectedTarget,
    selectedIds,
    sending,
  ]);

  const toggleSelect = useCallback((imageId: string) => {
    setSelectedIds((current) =>
      current.includes(imageId)
        ? current.filter((candidate) => candidate !== imageId)
        : [...current, imageId],
    );
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((current) => (current.length === images.length ? [] : images.map((image) => image.id)));
  }, [images]);

  const onInstructionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void regenerate();
      }
    },
    [regenerate],
  );

  const hasAttachments = attachments.hasAttachments;
  const canRegenerate =
    (instruction.trim().length > 0 || hasAttachments) && selectedIds.length > 0 && !sending;

  return (
    <div className={styles.review} data-tone={statusTone(status)} data-busy={busy ? 'true' : undefined}>
      <div className={styles.header}>
        <span className={styles.icon}>
          {busy || status === 'generating' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <ImageIcon size={13} />
          )}
        </span>
        <span className={styles.title}>{t('sessionWorkbenchUi.imageReview.title')}</span>
        <span className={styles.statusTag}>{STATUS_KEY[status] ? t(STATUS_KEY[status]) : status}</span>
        <span className={styles.progress}>
          {completed}/{images.length}
        </span>
        {countdown !== null && (
          <span className={styles.countdown}>
            {t('sessionWorkbenchUi.imageReview.autoConfirmSeconds', { seconds: countdown })}
          </span>
        )}
      </div>

      {images.length > 0 && (
        <div className={styles.grid}>
          {images.map((image) => (
            <Tile
              key={image.id}
              image={image}
              nodeStatus={status}
              selectable={editable}
              selected={selectedIds.includes(image.id)}
              onToggle={() => toggleSelect(image.id)}
              onDelete={() => void deleteImage(image.id)}
              onPreview={onPreviewImage}
            />
          ))}
        </div>
      )}

      <div className={styles.controls}>
        {noticeText && <div className={styles.notice}>{noticeText}</div>}

        {editable && (
          <GateAttachments
            images={attachments.images}
            files={attachments.files}
            onRemove={attachments.remove}
            onPreviewImage={onPreviewImage}
          />
        )}

        {editable && (
          <div className={styles.controlRow}>
            {modelOptions.length > 0 && (
              <Select
                value={modelValue}
                options={modelOptions}
                onChange={(value) => void changeModel(value)}
                ariaLabel={t('sessionWorkbenchUi.imageReview.model')}
              />
            )}

            <textarea
              className={styles.instruction}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={onInstructionKeyDown}
              onPaste={onPaste}
              placeholder={
                selectedIds.length === 0
                  ? t('sessionWorkbenchUi.imageReview.selectImagesFirst')
                  : t('sessionWorkbenchUi.imageReview.editPlaceholder')
              }
              rows={1}
            />

            <button
              type="button"
              className={styles.button}
              data-variant="primary"
              onClick={() => void regenerate()}
              disabled={!canRegenerate}
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <SendHorizonal size={12} />}
              {t('sessionWorkbenchUi.imageReview.regenerate')}
            </button>
          </div>
        )}

        <div className={styles.controlRow}>
          {editable ? (
            <>
              <button type="button" className={styles.button} onClick={toggleSelectAll}>
                {selectedIds.length === images.length
                  ? t('sessionWorkbenchUi.imageReview.clearSelection')
                  : t('sessionWorkbenchUi.imageReview.selectAll')}
              </button>
              <span className={styles.hint}>
                {t('sessionWorkbenchUi.imageReview.selectedCount', { count: selectedIds.length })}
                {!supportsEditing && ` ${t('sessionWorkbenchUi.imageReview.selectedEditUnsupported')}`}
              </span>
            </>
          ) : (
            <span className={styles.hint}>
              {status === 'preview' ? t('sessionWorkbenchUi.imageReview.confirmHint') : ''}
            </span>
          )}

          {(status === 'preview' || editable) && (
            <button type="button" className={styles.button} data-variant="primary" onClick={() => void approve()}>
              <Check size={12} />
              {t('sessionWorkbenchUi.imageReview.confirmAll')}
            </button>
          )}

          {status === 'preview' && (
            <button type="button" className={styles.button} onClick={() => void enterEdit()}>
              {t('sessionWorkbenchUi.imageReview.revise')}
            </button>
          )}

          {canCancel && (
            <button type="button" className={styles.button} data-variant="danger" onClick={() => void cancel()}>
              <X size={12} />
              {t('sessionWorkbenchUi.imageReview.cancelGeneration')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

ImageReview.displayName = 'ImageReview';
