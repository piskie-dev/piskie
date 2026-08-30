import fs from 'node:fs/promises';
import { z } from 'zod';
import { configFileWriter } from '../../config/core/atomic-file-writer.js';
import type { InferenceConfigPaths } from './config-repository.js';

const runtimeReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  domain: z.literal('inference'),
  revision: z.number().int().nonnegative(),
  catalogVersion: z.string().min(1),
  publisher: z.enum(['electron', 'cli', 'test']),
  processId: z.number().int().positive(),
  publishedAt: z.string().datetime(),
}).strict();

export type RuntimeReceipt = z.infer<typeof runtimeReceiptSchema>;

export async function writeRuntimeReceipt(
  paths: InferenceConfigPaths,
  receipt: RuntimeReceipt,
): Promise<void> {
  const parsed = runtimeReceiptSchema.parse(receipt);
  await configFileWriter.replace(paths.runtimeReceiptFile, `${JSON.stringify(parsed, null, 2)}\n`);
}

export async function readRuntimeReceipt(
  paths: InferenceConfigPaths,
): Promise<RuntimeReceipt | undefined> {
  let source: string;
  try {
    source = await fs.readFile(paths.runtimeReceiptFile, 'utf8');
  } catch (cause) {
    if (isNodeError(cause, 'ENOENT')) return undefined;
    throw cause;
  }
  return runtimeReceiptSchema.parse(JSON.parse(source));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
