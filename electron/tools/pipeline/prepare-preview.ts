import type { PreparedCall } from '../types.js';

export async function preparePreview(call: PreparedCall<unknown>): Promise<void> {
  call.preview = await call.entry.tool.prepare?.(call.params, call.ctx);
}
