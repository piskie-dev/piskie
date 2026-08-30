export type JsonPatchOperation =
  | { op: 'add' | 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export class JsonPatchError extends Error {
  constructor(
    readonly code:
      | 'PATCH_INVALID_POINTER'
      | 'PATCH_TARGET_NOT_FOUND'
      | 'PATCH_INVALID_INDEX'
      | 'PATCH_ROOT_REMOVE_FORBIDDEN',
    readonly operationIndex: number,
    readonly pointer: string,
    message: string,
  ) {
    super(message);
    this.name = 'JsonPatchError';
  }
}

export function applyJsonPatch<T>(document: T, operations: readonly JsonPatchOperation[]): T {
  let current: unknown = structuredClone(document);
  operations.forEach((operation, index) => {
    current = applyOperation(current, operation, index);
  });
  return current as T;
}

function applyOperation(document: unknown, operation: JsonPatchOperation, index: number): unknown {
  const tokens = parsePointer(operation.path, index);
  if (tokens.length === 0) {
    if (operation.op === 'remove') {
      throw new JsonPatchError('PATCH_ROOT_REMOVE_FORBIDDEN', index, operation.path, 'Cannot remove the config root');
    }
    return structuredClone(operation.value);
  }

  const parent = resolveParent(document, tokens, operation, index);
  const key = tokens.at(-1)!;
  if (Array.isArray(parent)) return applyArrayOperation(document, parent, key, operation, index);
  if (!isRecord(parent)) {
    throw new JsonPatchError('PATCH_TARGET_NOT_FOUND', index, operation.path, `Patch parent is not an object: ${operation.path}`);
  }
  if ((operation.op === 'remove' || operation.op === 'replace') && !Object.hasOwn(parent, key)) {
    throw new JsonPatchError('PATCH_TARGET_NOT_FOUND', index, operation.path, `Patch target does not exist: ${operation.path}`);
  }
  if (operation.op === 'remove') delete parent[key];
  else parent[key] = structuredClone(operation.value);
  return document;
}

function applyArrayOperation(
  document: unknown,
  parent: unknown[],
  key: string,
  operation: JsonPatchOperation,
  index: number,
): unknown {
  if (operation.op === 'add' && key === '-') {
    parent.push(structuredClone(operation.value));
    return document;
  }
  const arrayIndex = Number(key);
  if (!Number.isInteger(arrayIndex) || arrayIndex < 0) {
    throw new JsonPatchError('PATCH_INVALID_INDEX', index, operation.path, `Invalid array index: ${key}`);
  }
  const exists = arrayIndex < parent.length;
  if (operation.op === 'add') {
    if (arrayIndex > parent.length) {
      throw new JsonPatchError('PATCH_INVALID_INDEX', index, operation.path, `Array index is out of bounds: ${key}`);
    }
    parent.splice(arrayIndex, 0, structuredClone(operation.value));
  } else if (!exists) {
    throw new JsonPatchError('PATCH_TARGET_NOT_FOUND', index, operation.path, `Patch target does not exist: ${operation.path}`);
  } else if (operation.op === 'remove') {
    parent.splice(arrayIndex, 1);
  } else {
    parent[arrayIndex] = structuredClone(operation.value);
  }
  return document;
}

function resolveParent(
  document: unknown,
  tokens: readonly string[],
  operation: JsonPatchOperation,
  index: number,
): unknown {
  let current = document;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(current)) {
      const arrayIndex = Number(token);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) {
        throw new JsonPatchError('PATCH_TARGET_NOT_FOUND', index, operation.path, `Patch parent does not exist: ${operation.path}`);
      }
      current = current[arrayIndex];
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      throw new JsonPatchError('PATCH_TARGET_NOT_FOUND', index, operation.path, `Patch parent does not exist: ${operation.path}`);
    }
  }
  return current;
}

function parsePointer(pointer: string, index: number): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new JsonPatchError('PATCH_INVALID_POINTER', index, pointer, `JSON Pointer must start with '/': ${pointer}`);
  }
  return pointer.slice(1).split('/').map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
