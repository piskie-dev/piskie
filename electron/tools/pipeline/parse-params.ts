import { parse } from '../params.js';
import type { Rejection } from '../types.js';
import { REJECT } from './rejections.js';
import type { PrepareDraft } from './types.js';

export function parseParams(call: PrepareDraft): void | Rejection {
  const parsed = parse(call.entry.tool.def.schema, call.rawParams);
  if (!parsed.ok) return { text: REJECT.shapeViolation(parsed.errors) };
  call.params = parsed.value;
}
