/**
 * 状态语义 → 展示属性（四套并行颜色词汇的收敛处）。
 *
 * 关键约定：**这里不返回颜色**。只给 `tone` 与脉冲语义，
 * 颜色由 CSS 通过 `[data-tone="..."]` 选择器从 `status-*` token 取。
 * 这样 TSX 里零色值、零内联颜色（style-guide 铁律 1、2），
 * 且色值改动只需动 `tokens.css` 一处。
 */

import type { StatusKey } from '../data/vm';

/** 语义色阶键；对应 tokens.css 的 `--status-*` */
export type StatusTone = 'running' | 'thinking' | 'waiting' | 'error';

export interface StatusPresentation {
  readonly tone: StatusTone;
  /** 是否需要脉冲提示（进行中的瞬态） */
  readonly pulse: boolean;
}

const PRESENTATION: Record<StatusKey, StatusPresentation> = {
  stopping: { tone: 'waiting', pulse: true },
  interrupted: { tone: 'waiting', pulse: false },
  thinking: { tone: 'thinking', pulse: true },
  waiting: { tone: 'waiting', pulse: false },
  running: { tone: 'running', pulse: true },
};

export function statusOf(status: StatusKey): StatusPresentation {
  return PRESENTATION[status];
}
