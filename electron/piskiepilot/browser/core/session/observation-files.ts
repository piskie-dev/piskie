/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/McpContext.ts
 * (ensureExtension, saveFile, saveTemporaryFile). Host roots and temp directory
 * replace MCP roots and the upstream temporary-directory owner.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCanonicalPath, validatePathWithinRoots } from './file-roots.js';

export interface ObservationFileOptions {
  readonly cwd: string;
  readonly tempDir: string;
  readonly allowedRoots: readonly string[];
}

export type ObservationExtension = '.png' | '.jpeg' | '.webp' | '.json' | '.txt'
  | '.network-request' | '.network-response';

/** Precheck the client path before the action; normalized output is checked on write. */
export async function validateObservationFile(
  filename: string,
  extension: ObservationExtension,
  options: ObservationFileOptions,
): Promise<string> {
  const inputPath = path.resolve(options.cwd, filename);
  await validatePathWithinRoots(inputPath, options.allowedRoots);
  const canonicalPath = await resolveCanonicalPath(inputPath);
  const currentExtension = path.extname(canonicalPath);
  const outputPath = canonicalPath.slice(0, canonicalPath.length - currentExtension.length) + extension;
  return outputPath;
}

export async function saveObservationFile(
  data: Uint8Array,
  filename: string,
  extension: ObservationExtension,
  options: ObservationFileOptions,
): Promise<{ filename: string }> {
  const outputPath = await validateObservationFile(filename, extension, options);
  await writeFile(outputPath, data, options.allowedRoots);
  return { filename: outputPath };
}

export async function saveTemporaryObservationFile(
  data: Uint8Array,
  filename: string,
  options: ObservationFileOptions,
): Promise<{ filepath: string }> {
  await fs.mkdir(options.tempDir, { recursive: true });
  const directory = await fs.mkdtemp(path.join(options.tempDir, 'browser-observation-'));
  const filepath = path.join(directory, filename);
  await writeFile(filepath, data, [options.tempDir]);
  return { filepath };
}

async function writeFile(filepath: string, data: Uint8Array, roots: readonly string[]): Promise<void> {
  await validatePathWithinRoots(filepath, roots);
  const resolved = await resolveCanonicalPath(filepath);
  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, data, {
      flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
        | fs.constants.O_NOFOLLOW,
      mode: 0o600,
    });
  } catch (error) {
    throw new Error(`Could not write ${filepath}`, { cause: error });
  }
}
