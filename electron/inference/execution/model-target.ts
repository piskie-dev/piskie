import type { ModelTarget } from './contracts.js';

export function parseModelTargetReference(reference: string): ModelTarget {
  const separator = reference.indexOf('::');
  if (separator <= 0 || separator === reference.length - 2) {
    throw new Error(`Model reference must use providerId::modelId: ${reference}`);
  }
  return {
    providerId: reference.slice(0, separator),
    modelId: reference.slice(separator + 2),
  };
}

export function formatModelTarget(target: ModelTarget): string {
  return `${target.providerId}::${target.modelId}`;
}
