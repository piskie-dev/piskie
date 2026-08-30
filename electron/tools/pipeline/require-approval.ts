import type { PreparedCall, Rejection } from '../types.js';
import { decideApproval } from './approval-policy.js';
import { InvariantViolation } from './invariant-violation.js';
import { REJECT } from './rejections.js';
import type { PipelineRuntime } from './types.js';

export async function requireApproval(
  call: PreparedCall<unknown>,
  runtime: PipelineRuntime,
): Promise<void | Rejection> {
  const decision = decideApproval(call);
  if (!decision.needs) return;
  if (!runtime.approval) {
    throw new InvariantViolation(`Approval port missing for ${call.entry.modelName}`);
  }
  const preview = call.preview ? await call.preview() : undefined;
  const answer = await runtime.approval.request({
    call,
    description: decision.reason,
    preview,
    modeInvariant: decision.modeInvariant,
  });
  return answer.decision === 'allow' ? undefined : { text: REJECT.approvalDenied() };
}
