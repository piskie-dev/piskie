/**
 * ReviewSlot —— 审阅面的取数层。
 *
 * 与 `RightPanelSlot` 同一个理由要单独成组件：它得自己订阅自己那个 agent 的流水
 * （`useTranscript`），不能由 `RightPanel` 统一取 —— 后者只有当前 tab 的数据。
 *
 * 工具消息从已有流水按 id 取回；正文中的本地路径则携带桌面预览结果。
 * 两种目标最终都进入同一个 `ReviewPanel`。
 */

import { memo, useMemo } from 'react';

import { fileChangeOf, readOpOf } from '../data/review';
import { useTranscript } from '../data/useTranscript';
import type { FileReviewTarget } from './fileReviewTarget';
import { ReviewPanel } from './ReviewPanel';

export interface ReviewSlotProps {
  readonly agentId: string;
  readonly workerId?: string;
  readonly target?: FileReviewTarget;
}

export const ReviewSlot = memo<ReviewSlotProps>(({ agentId, workerId, target }) => {
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
  const preview = target?.kind === 'path'
    ? { path: target.path, descriptor: target.preview }
    : null;

  return (
    <ReviewPanel
      change={change}
      read={read}
      preview={preview}
      onOpenPath={(path) => void window.piskie.desktop.system.openPath(path)}
      onRevealPath={(path) => void window.piskie.desktop.system.revealPath(path)}
    />
  );
});

ReviewSlot.displayName = 'ReviewSlot';
