import * as path from 'node:path';
import type { Rejection } from '../types.js';
import { REJECT } from './rejections.js';
import type { PrepareDraft } from './types.js';

export function normalizePaths(call: PrepareDraft): void | Rejection {
  const declarations = call.entry.tool.def.policy?.pathParams;
  if (!declarations) return;

  const params = call.params as Record<string, unknown>;
  for (const [param, mode] of Object.entries(declarations)) {
    let value = params[param];
    if ((value === undefined || value === '') && mode === 'workspace-default') {
      value = call.ctx.workspace.dir;
      params[param] = value;
    }
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return { text: REJECT.shapeViolation([`${param}: Expected string`]) };
    }
    if (!path.isAbsolute(value)) {
      return { text: REJECT.relativePath(param, value, call.ctx.workspace.dir) };
    }
    params[param] = path.normalize(value);
  }
}
