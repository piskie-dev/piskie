import { appLog } from '@electron/observability/logging/app-log.js';
import { createUuid } from '@shared/utils/identifiers.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { PreparedCall, ToolResult } from '../types.js';

export type PersistOverflowOptions = Readonly<{
  maxInlineBytes?: number;
  onWarning?: (message: string, error: unknown) => void;
}>;

/** The sole writer of ToolResult.persisted. Disk failures degrade to inline text. */
export async function persistOverflow(
  call: Pick<PreparedCall<unknown>, 'ctx'>,
  result: ToolResult,
  options: PersistOverflowOptions = {}
): Promise<void> {
  const { ctx } = call;
  try {
    const fromSpool = ctx.spool?.spilled() ?? null;
    if (fromSpool) {
      result.persisted = fromSpool;
      return;
    }

    const bytes = Buffer.byteLength(result.text, 'utf8');
    if (bytes <= (options.maxInlineBytes ?? 64 * 1024)) return;

    await fs.mkdir(ctx.workspace.tempDir, { recursive: true });
    const outputPath = path.join(ctx.workspace.tempDir, `output-${createUuid()}.log`);
    await fs.writeFile(outputPath, result.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    result.persisted = {
      path: outputPath,
      bytes,
      preview: Buffer.from(result.text)
        .subarray(0, 2 * 1024)
        .toString('utf8'),
    };
  } catch (error) {
    const message = 'Failed to persist oversized tool output';
    if (options.onWarning) {
      options.onWarning(message, error);
    } else {
      appLog.warn({
        event: 'tool.output.persist.degraded',
        message: 'Tool output persistence degraded',
        context: {
          scope: 'tool.output',
          agentId: ctx.agentId,
          callId: ctx.callId,
        },
        error,
      });
    }
  }
}
