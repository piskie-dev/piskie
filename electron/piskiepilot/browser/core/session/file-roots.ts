/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.7.0 src/utils/files.ts and
 * McpContext.validatePath. MCP roots are supplied by Piskie's existing
 * workspace and temporary-directory owners.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export async function validatePathWithinRoots(
  filePath: string,
  roots: readonly string[],
): Promise<void> {
  let canonicalPath: string;
  try {
    canonicalPath = await resolveCanonicalPath(filePath);
  } catch {
    throw new Error(`Access denied: Cannot resolve base path for ${filePath}.`);
  }

  const canonicalRoots = await Promise.allSettled(
    roots.map(async (root) => fs.realpath(path.resolve(root))),
  );
  const allowed = canonicalRoots.some((result) => (
    result.status === 'fulfilled'
    && (
      canonicalPath === result.value
      || canonicalPath.startsWith(result.value + path.sep)
    )
  ));
  if (!allowed) {
    throw new Error(
      `Access denied: path ${filePath} (canonical: ${canonicalPath}) `
      + 'is not within any of the configured workspace roots.',
    );
  }
}

export async function resolveCanonicalPath(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  try {
    return await fs.realpath(absolutePath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;

    let current = absolutePath;
    const missingSegments: string[] = [];
    while (current !== path.dirname(current)) {
      const parent = path.dirname(current);
      try {
        const canonicalParent = await fs.realpath(parent);
        return path.join(canonicalParent, path.basename(current), ...missingSegments);
      } catch (parentError) {
        if (!isMissingPathError(parentError)) throw parentError;
        missingSegments.unshift(path.basename(current));
        current = parent;
      }
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
