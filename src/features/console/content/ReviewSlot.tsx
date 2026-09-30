/**
 * ReviewSlot —— 审阅面的取数层。
 *
 * 与 `RightPanelSlot` 同一个理由要单独成组件：它得自己订阅自己那个 agent 的流水
 * （`useTranscript`），不能由 `RightPanel` 统一取 —— 后者只有当前 tab 的数据。
 *
 * 工具消息从已有流水按 id 取回；正文中的本地路径则携带桌面预览结果。
 * 两种目标最终都进入同一个 `ReviewPanel`。
 */

import { memo, useCallback, useMemo, type RefObject } from 'react';
import type { ImagePreviewHandler } from '@/components/image-preview/renderedImageContext';

import { fileChangeOf, readOpOf } from '../data/review';
import { useTranscript } from '../data/useTranscript';
import type { FileReviewTarget, UpdateFileReviewTarget } from './fileReviewTarget';
import { ReviewPanel } from './ReviewPanel';
import { FileChangesReview } from './FileChangesReview';

export interface ReviewSlotProps {
  readonly agentId: string;
  readonly workerId?: string;
  readonly target?: FileReviewTarget;
  readonly scrollContainerRef?: RefObject<HTMLDivElement>;
  readonly onUpdateTarget?: UpdateFileReviewTarget;
  readonly onPreviewImage?: ImagePreviewHandler;
}

export const ReviewSlot = memo<ReviewSlotProps>(({ agentId, workerId, target, onPreviewImage, onUpdateTarget, scrollContainerRef }) => {
  const transcript = useTranscript(workerId ?? agentId, {
    active: target?.kind === 'cell',
  });

  const focused = useMemo(
    () => (
      target?.kind === 'cell'
        ? (transcript.nodes.find((node) => node.id === target.cellId) ?? null)
        : null
    ),
    [target, transcript.nodes],
  );
  const change = useMemo(() => (focused ? fileChangeOf(focused) : null), [focused]);
  const read = useMemo(() => (focused ? readOpOf(focused) : null), [focused]);
  const preview = useMemo(() => target?.kind === 'path'
    ? { path: target.path, descriptor: target.preview }
    : null, [target]);
  const updatePreview = useCallback<NonNullable<import('./ReviewPanel').ReviewPanelProps['onUpdatePreview']>>((expected, next) => {
    if (target?.kind !== 'path' || target.path !== expected.path || target.preview !== expected.descriptor) return;
    onUpdateTarget?.(target, next ? { ...target, preview: next } : null);
  }, [target, onUpdateTarget]);
  const openPath = useCallback((path: string) => window.piskie.desktop.system.openPath(path), []);
  const revealPath = useCallback((path: string) => window.piskie.desktop.system.revealPath(path), []);

  if (target?.kind === 'collection') {
    return <FileChangesReview key={workerId ?? agentId} agentId={workerId ?? agentId} includeWorkers={!workerId} />;
  }

  return (
    <ReviewPanel
      key={workerId ?? agentId}
      change={change}
      read={read}
      preview={preview}
      scrollContainerRef={scrollContainerRef}
      onUpdatePreview={updatePreview}
      onPreviewImage={onPreviewImage}
      onOpenPath={openPath}
      onRevealPath={revealPath}
    />
  );
});

ReviewSlot.displayName = 'ReviewSlot';
