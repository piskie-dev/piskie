import type { WorkerTypeDescriptor } from '../../../shared/types/worker-preferences.js';
import type { SpecRegistry } from './spec-registry.js';

/** A read-only projection; importing this module never initializes the registry or tools. */
export function listWorkerTypes(registry: Pick<SpecRegistry, 'getAll'>): WorkerTypeDescriptor[] {
  return registry
    .getAll()
    .filter((spec) => spec.role === 'worker')
    .map((spec) => ({ type: spec.name, description: spec.subagentTypeDescription ?? spec.name }))
    .sort((left, right) => left.type.localeCompare(right.type));
}
