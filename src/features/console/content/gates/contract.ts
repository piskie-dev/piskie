/**
 * 审批门契约。
 *
 * 门只往上抛**决定**，不知道 IPC、不知道 store、不知道自己挂在 dock 还是 thread，
 * 也不在 JSX 里内联审批响应的对象字面量。
 *
 * 门的种类是**判别联合**：互斥由类型保证，不是由四个 `&&` 条件的书写顺序保证。
 */

import type { AIQuestionItem, PendingToolCall } from '../../../../../shared/types';

export type GateImage = { readonly data: string; readonly media_type: string };

/** 门请求——由 `resolveGateRequest` 从 VM 唯一派生 */
export type GateRequest =
  | { readonly kind: 'tool'; readonly call: PendingToolCall }
  | { readonly kind: 'diff'; readonly call: PendingToolCall }
  | { readonly kind: 'command'; readonly call: PendingToolCall }
  | { readonly kind: 'plan'; readonly call: PendingToolCall; readonly taskSummary: string }
  | { readonly kind: 'question'; readonly id: string; readonly items: readonly AIQuestionItem[] };

/** 用户的决定——与既有 IPC 载荷一一对应，接线层直接转发 */
export type GateDecision =
  | {
      readonly kind: 'allow';
      readonly callId: string;
      readonly changeToAuto: boolean;
    }
  | {
      readonly kind: 'deny';
      readonly callId: string;
      readonly feedback: string;
      readonly images?: readonly GateImage[];
    }
  | {
      readonly kind: 'answer';
      /** = 发起提问的 ask_user tool_use ID（问题身份唯一来源，没有第二个 id） */
      readonly callId: string;
      readonly answer: string;
      /**
       * 逐题原始答案：与 questions 同序、不含附件说明，
       * 经 uiSubmission 旁路持久化为 ask_user_answers artifact。
       */
      readonly answers: readonly string[];
      readonly images?: readonly GateImage[];
    };

/** 各门共用的入参（`request` 由各门自己收窄） */
export interface GateCommonProps {
  readonly disabled?: boolean;
  readonly onDecide: (decision: GateDecision) => void;
  readonly onPreviewImage?: (src: string) => void;
}
