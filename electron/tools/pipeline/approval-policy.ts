import type { PreparedCall } from '../types.js';

export type ApprovalDecision =
  | { needs: false }
  | { needs: true; reason: string; modeInvariant: boolean };

const ALWAYS_ALLOWED = new Set([
  'ask_user',
  'send_event',
  'plan',
  'task',
  'task_read',
  'read',
  'glob',
  'grep',
  'ls',
  'tool_search',
  'load_skill',
]);

export function decideApproval(call: PreparedCall<unknown>): ApprovalDecision {
  const { entry } = call;
  const params = call.params as Record<string, unknown>;
  const planCreate = entry.modelName === 'plan'
    && params.action === 'create';
  if (planCreate) {
    return {
      needs: true,
      reason: '计划正文必须由用户确认。',
      modeInvariant: true,
    };
  }
  if (ALWAYS_ALLOWED.has(entry.modelName)) return { needs: false };
  if (call.ctx.modes.approvalMode() === 'auto') return { needs: false };
  return {
    needs: true,
    reason: '当前审批模式要求确认此工具调用。',
    modeInvariant: false,
  };
}
