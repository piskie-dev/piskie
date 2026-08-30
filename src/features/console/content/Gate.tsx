/**
 * Gate —— 审批门外壳。
 *
 * 三条约定：
 * - 互斥由 `resolveGateRequest` 一次决策 + 判别联合承载，**不可能同时出现两个门**
 * - 高度由 `Panel` 的 flex 布局吸收，门是自然高度的底部带，零高度常量——
 *   用绝对定位覆盖层就得靠常量给面板预留高度，门改一点常量就得跟着改
 * - 门与 composer 的互斥在 `Panel` 里（`gate ? … : footer`），本组件不关心
 */

import { memo } from 'react';

import type { GateDecision, GateRequest } from './gates/contract';
import { CommandGate } from './gates/CommandGate';
import { DiffGate } from './gates/DiffGate';
import { PlanGate } from './gates/PlanGate';
import { QuestionGate } from './gates/QuestionGate';
import { ToolGate } from './gates/ToolGate';

// 只再导出类型：值导出会让本文件不再是纯组件模块，破坏 HMR 的 fast refresh。
// `resolveGateRequest` 从 `./gates/resolve` 直接引。
export type { GateDecision, GateImage, GateRequest } from './gates/contract';
export type { GateSource } from './gates/resolve';

export interface GateProps {
  readonly request: GateRequest;
  /** 停止中 / 等待中时锁门 */
  readonly disabled?: boolean;
  readonly onDecide: (decision: GateDecision) => void;
  readonly onViewDiff?: () => void;
  readonly onPreviewImage?: (src: string) => void;
}

function noop() {}

export const Gate = memo<GateProps>(
  ({ request, disabled, onDecide, onViewDiff, onPreviewImage }) => {
    const common = { disabled, onDecide, onPreviewImage };

    switch (request.kind) {
      case 'tool':
        return <ToolGate request={request} {...common} />;

      case 'diff':
        return <DiffGate request={request} onViewDiff={onViewDiff ?? noop} {...common} />;

      case 'command':
        return <CommandGate request={request} {...common} />;

      case 'plan':
        return <PlanGate request={request} {...common} />;

      case 'question':
        return <QuestionGate request={request} {...common} />;
    }
  },
);

Gate.displayName = 'Gate';
