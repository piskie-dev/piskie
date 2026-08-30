import type { TaskDefinition } from '../../shared/types';

function uniqueEnvironmentIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function getTaskDefinitionEnvironmentIds(
  definition: Pick<TaskDefinition, 'metadata'>,
): string[] {
  const metadata = definition?.metadata;
  if (metadata?.type !== 'standard') return [];
  return uniqueEnvironmentIds(metadata.boundEnvironmentIds ?? []);
}

export function buildStandardTaskBindings(
  environmentIds: readonly string[],
): TaskDefinition['metadata'] | undefined {
  const boundEnvironmentIds = uniqueEnvironmentIds(environmentIds);
  if (boundEnvironmentIds.length === 0) return undefined;
  return { type: 'standard', boundEnvironmentIds };
}
