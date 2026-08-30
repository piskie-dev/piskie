/**
 * 语义色阶与状态徽章，全前端唯一一套。
 *
 * tone 由 **kind + 工具状态**共同决定，因此拆成几个小函数由 build 侧按需调用：
 *
 * | kind / 状态                | tone    |
 * |----------------------------|---------|
 * | tool + phase failed        | danger  |
 * | tool + phase awaiting-approval | warning |
 * | tool + phase cancelled     | warning |
 * | tool + phase running       | live    |
 * | tool + phase ok            | neutral |
 * | user + origin assignment   | live    |
 * | user + origin user/parent  | neutral |
 * | assistant                  | neutral |
 * | notice                     | neutral |
 * | turn / summary             | muted   |
 */

import type { TranscriptBadge, TranscriptTone, ToolState } from '@/domains/transcript/nodes';

export function toolTone(state: ToolState): TranscriptTone {
  switch (state.phase) {
    case 'failed':
      return 'danger';
    case 'awaiting-approval':
    case 'cancelled':
      return 'warning';
    case 'running':
      return 'live';
    case 'ok':
      return 'neutral';
  }
}

export function toolBadge(state: ToolState): TranscriptBadge | undefined {
  switch (state.phase) {
    case 'running':
      return 'running';
    case 'awaiting-approval':
      return 'awaiting-approval';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'ok':
      return undefined;
  }
}

export function userTone(origin: 'user' | 'assignment' | 'parent'): TranscriptTone {
  return origin === 'assignment' ? 'live' : 'neutral';
}

/** summary 是背景信息，其余静态内容走中性。 */
export function staticTone(
  kind: 'assistant' | 'summary' | 'notice' | 'worker',
): TranscriptTone {
  return kind === 'summary' ? 'muted' : 'neutral';
}

/** 计划正文：待确认时取 warning（与其他待审批条目同色），终态中性 */
export function planTone(pending: boolean): TranscriptTone {
  return pending ? 'warning' : 'neutral';
}
