/**
 * 对话协议核心：ask_user 挂起/配对/结算的唯一判定来源。
 *
 * - parseAskUserInput：ask_user 参数唯一归一化——工具校验、pending 判据、
 *   恢复判定、UI 问题构造、验证失败文本共用，各写一份必然漂移
 * - inspectLatestToolBatch：尾部检查——检查"最新 assistant 消息"，
 *   纯文本尾部即 undefined，绝不向前扫描
 * - resolveToolUseSettlement：Settler 的 ID 解析逻辑（结算与
 *   pending 判据共用，"可唯一结算"不是独立协议检查器）
 * - buildToolInterruptionResult：canonical interrupted 统一 builder
 *   （仅限 engine 自写路径；工具管线取消产物维持现状）
 */

import type { Message, ContentBlock, AIQuestionItem } from '../../../shared/types/index.js';
import { bool, z } from '../../tools/params.js';

// ============================================================
// 常量（固定文案：错误即文档）
// ============================================================

/** yield gate 违规固定文案：教 AI 合并 questions 数组后重试 */
export const ASK_USER_GATE_VIOLATION_TEXT =
  'ask_user 必须作为本轮唯一的工具调用，本批所有工具均未执行。' +
  '如需询问多个问题，请将它们合并到一次 ask_user 调用的 questions 数组中，然后重试。';

// ============================================================
// parseAskUserInput
// ============================================================

export interface NormalizedAskUserInput {
  /** 长度 ≥ 1；不兼容旧的顶层单 question 形状（零迁移） */
  questions: AIQuestionItem[];
}

export type AskUserParseResult =
  | { ok: true; value: NormalizedAskUserInput }
  | { ok: false; error: string };

const ASK_USER_SHAPE_HINT =
  '正确形状：{ "questions": [{ "question": string, "options"?: string[], "multiSelect"?: boolean }, …] }（questions 数组长度 ≥ 1）。';

/**
 * ask_user 参数唯一解析入口：parse 而非 validate——归一化（trim/默认值）只写一份。
 * 失败返回的 error 文本直接作为验证失败 tool_result 写回（错误即文档）。
 */
export const askUserSchema = z.object({
  questions: z.array(z.object({
    question: z.string().trim().min(1).describe('只询问一个事项的问题'),
    options: z.array(z.string().trim().min(1)).optional()
      .describe('可选答案；省略时由用户自由回答'),
    multiSelect: bool().optional().default(false)
      .describe('是否允许选择多个答案'),
  })).min(1).describe('待用户回答的问题列表'),
});

export function parseAskUserInput(input: unknown): AskUserParseResult {
  const parsed = askUserSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('；');
    return { ok: false, error: `ask_user 参数无效：${details}。${ASK_USER_SHAPE_HINT}` };
  }
  return { ok: true, value: parsed.data };
}

// ============================================================
// inspectLatestToolBatch
// ============================================================

export interface LatestToolBatchCall {
  id: string;
  name: string;
  input: unknown;
  /** 全上下文中是否已存在对应 tool_result */
  settled: boolean;
}

export interface LatestToolBatch {
  calls: LatestToolBatchCall[];
}

function isToolUseBlock(block: unknown): block is ContentBlock & { id: string; name: string } {
  return (
    typeof block === 'object' && block !== null &&
    (block as ContentBlock).type === 'tool_use' &&
    typeof (block as ContentBlock).id === 'string' &&
    typeof (block as ContentBlock).name === 'string'
  );
}

function isToolResultBlock(block: unknown): block is ContentBlock & { tool_use_id: string } {
  return (
    typeof block === 'object' && block !== null &&
    (block as ContentBlock).type === 'tool_result' &&
    typeof (block as ContentBlock).tool_use_id === 'string'
  );
}

/** 收集全上下文已存在的 tool_result IDs（settled 判定共用） */
function collectSettledIds(messages: Message[]): Set<string> {
  const settled = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isToolResultBlock(block)) settled.add(block.tool_use_id);
    }
  }
  return settled;
}

/**
 * 尾部检查（严格算法）：检查的是"最新 assistant 消息"，
 * 不是"最新一条含 tool_use 的 assistant 消息"。
 * 1. 从尾部反向找到第一条 assistant 消息；
 * 2. 不含 tool_use → 立即返回 undefined；
 * 3. 含 tool_use → 只计算这一批 call 的结果状态；
 * 4. 无论这批完整与否，都停止；绝不跳过纯文本 assistant 继续向前。
 */
export function inspectLatestToolBatch(messages: Message[]): LatestToolBatch | undefined {
  let latestAssistant: Message | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      latestAssistant = messages[i];
      break;
    }
  }
  if (!latestAssistant || !Array.isArray(latestAssistant.content)) return undefined;

  const calls: LatestToolBatchCall[] = [];
  for (const block of latestAssistant.content) {
    if (isToolUseBlock(block)) {
      calls.push({ id: block.id, name: block.name, input: block.input, settled: false });
    }
  }
  if (calls.length === 0) return undefined;

  const settledIds = collectSettledIds(messages);
  for (const call of calls) {
    call.settled = settledIds.has(call.id);
  }
  return { calls };
}

// ============================================================
// Settler 的 ID 解析逻辑（结算与 pending 判据共用）
// ============================================================

export type ToolSettlementResolution = 'insertable' | 'already_settled' | 'unresolvable';

/**
 * 目标 ID 在当前保留上下文中能否唯一结算（定向计数，不构成对较早批次的修复或选择——原则 4）：
 * - 恰好一个同 ID tool_use 且无结果 → insertable
 * - 恰好一个同 ID tool_use 且已有结果 → already_settled
 * - 没有对应 call 或存在重复 call ID → unresolvable
 */
export function resolveToolUseSettlement(messages: Message[], toolUseId: string): ToolSettlementResolution {
  let callCount = 0;
  let hasResult = false;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (isToolUseBlock(block) && block.id === toolUseId) callCount++;
      }
    } else if (msg.role === 'user') {
      for (const block of msg.content) {
        if (isToolResultBlock(block) && block.tool_use_id === toolUseId) hasResult = true;
      }
    }
  }
  if (callCount !== 1) return 'unresolvable';
  if (hasResult) return 'already_settled';
  return 'insertable';
}

// ============================================================
// 合法 pending ask_user 判据（pendingQuestion/UI/Pump 守卫/恢复共用）
// ============================================================

export interface PendingAskUser {
  toolUseId: string;
  input: NormalizedAskUserInput;
}

/**
 * 合法 pending 判据：最新 assistant 是工具批次 且 存在缺失结果 且 批次只有一个 call
 * 且 name === 'ask_user' 且 parseAskUserInput 成功 且 该 call ID 可唯一结算。
 * 判据不满足的"表面 pending"：不弹面板、不配对，消息走普通路径（不吞消息、不永久等待）。
 */
export function getValidPendingAskUser(messages: Message[]): PendingAskUser | undefined {
  const batch = inspectLatestToolBatch(messages);
  if (!batch) return undefined;
  if (batch.calls.length !== 1) return undefined;
  const call = batch.calls[0];
  if (call.settled || call.name !== 'ask_user') return undefined;
  const parsed = parseAskUserInput(call.input);
  if (!parsed.ok) return undefined;
  if (resolveToolUseSettlement(messages, call.id) !== 'insertable') return undefined;
  return { toolUseId: call.id, input: parsed.value };
}

/**
 * ESC 结算目标：最新开放批次中未结算的合法 ask_user。
 * 循环写批内每个是损坏/崩溃窗口防御——合法轨迹恒至多一个。
 */
export function getUnsettledValidAskCalls(messages: Message[], batch: LatestToolBatch): LatestToolBatchCall[] {
  return batch.calls.filter(call =>
    !call.settled &&
    call.name === 'ask_user' &&
    parseAskUserInput(call.input).ok &&
    resolveToolUseSettlement(messages, call.id) === 'insertable',
  );
}

// ============================================================
// canonical interrupted（仅限 engine 自写路径）
// ============================================================

export interface InterruptedToolResult {
  status: 'interrupted';
  reason: 'user_interrupted' | 'runtime_interrupted' | 'recovery_interrupted';
  /** not_started 仅在有直接证据"工具从未启动"时使用，其余一律 unknown（防模型重试有副作用操作） */
  execution: 'not_started' | 'unknown';
  message: string;
}

const INTERRUPTION_MESSAGES: Record<InterruptedToolResult['execution'], string> = {
  not_started: '执行被中断，该工具未启动。',
  unknown: '执行被中断，该工具是否已产生副作用未知，重试有副作用的操作前请先核实现状。',
};

/** 统一 builder：模型可见工具结果，不是本地异常 */
export function buildToolInterruptionResult(opts: {
  reason: InterruptedToolResult['reason'];
  execution: InterruptedToolResult['execution'];
  message?: string;
}): string {
  const result: InterruptedToolResult = {
    status: 'interrupted',
    reason: opts.reason,
    execution: opts.execution,
    message: opts.message ?? INTERRUPTION_MESSAGES[opts.execution],
  };
  return JSON.stringify(result);
}
