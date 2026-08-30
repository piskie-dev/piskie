/**
 * 默认展开策略。
 *
 * 三条规则：
 * 1. AI 回复默认展开（正文即内容，收起来没意义）
 * 2. 计划提交**待确认时**默认展开（正文即审批对象）；进终态后回落 false，
 *    由 UI 侧的"自动收起一次"逻辑处理
 */

import type { TranscriptInteraction, ToolState } from '@/domains/transcript/nodes';

export interface CellPolicy {
  readonly defaultExpanded: boolean;
  /** 非空则覆盖按内容体积推导出的交互形态 */
  readonly forceInteraction?: TranscriptInteraction;
}

const NO_POLICY: CellPolicy = { defaultExpanded: false };

/** AI 回复 */
export function assistantPolicy(): CellPolicy {
  return { defaultExpanded: true };
}

/** 计划正文：pending 才默认展开 */
export function planPolicy(pending: boolean): CellPolicy {
  return pending ? { defaultExpanded: true } : NO_POLICY;
}

export function toolPolicy(_tool: string, _state: ToolState): CellPolicy {
  return NO_POLICY;
}
