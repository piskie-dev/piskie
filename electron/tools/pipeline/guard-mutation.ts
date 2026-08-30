import type { PreparedCall, Rejection } from '../types.js';
import { InvariantViolation } from './invariant-violation.js';
import { REJECT } from './rejections.js';

export async function guardMutation(
  call: PreparedCall<unknown>,
): Promise<void | Rejection> {
  const mutation = call.entry.tool.def.policy?.mutation;
  if (!mutation || mutation.priorRead === 'none') return;
  if (!call.ctx.files) {
    throw new InvariantViolation(`${call.entry.modelName} declares mutation without ctx.files`);
  }

  const filePath = (call.params as Record<string, unknown>)[mutation.pathParam];
  if (typeof filePath !== 'string') {
    throw new InvariantViolation(`${call.entry.modelName} mutation path is not a string`);
  }
  const verdict = await call.ctx.files.check(filePath);
  if (verdict === 'current') return;
  if (verdict === 'absent' && mutation.priorRead === 'if-exists') return;
  return {
    text: verdict === 'stale' ? REJECT.staleRead(filePath) : REJECT.neverRead(filePath),
  };
}
