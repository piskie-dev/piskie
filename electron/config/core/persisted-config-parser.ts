import { ZodError } from 'zod';

/**
 * Persisted documents may contain keys that no longer belong to the current
 * contract. Ignore those keys generically while preserving validation for all
 * known fields. The source object and file are never rewritten during reads.
 */
export function parsePersistedConfig<T>(
  raw: unknown,
  parse: (candidate: unknown) => T,
): T {
  const candidate = structuredClone(raw);

  for (;;) {
    try {
      return parse(candidate);
    } catch (cause) {
      if (!(cause instanceof ZodError) || !removeUnknownKeys(candidate, cause)) {
        throw cause;
      }
    }
  }
}

function removeUnknownKeys(candidate: unknown, error: ZodError): boolean {
  let removed = false;

  for (const issue of error.issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    const owner = valueAtPath(candidate, issue.path);
    if (!isRecord(owner)) continue;

    for (const key of issue.keys) {
      if (!Object.hasOwn(owner, key)) continue;
      delete owner[key];
      removed = true;
    }
  }

  return removed;
}

function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') {
      current = current[segment];
      continue;
    }
    if (!isRecord(current) || typeof segment === 'symbol') return undefined;
    current = current[String(segment)];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
