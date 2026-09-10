export { specRegistry } from './spec-registry.js';
export type { WorkerDefinition } from './worker-definition.js';

import { specRegistry } from './spec-registry.js';
import { BUILTIN_DIRECTOR_SPECS, BUILTIN_WORKER_DEFINITIONS } from './builtin/index.js';
import { getStandaloneToolCatalog } from '../../tools/index.js';

for (const spec of BUILTIN_DIRECTOR_SPECS) specRegistry.register(spec);
for (const definition of BUILTIN_WORKER_DEFINITIONS) {
  specRegistry.registerWorker(definition, getStandaloneToolCatalog());
}
