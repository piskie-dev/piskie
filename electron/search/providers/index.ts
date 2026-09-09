import type { SearchProviderDefinition } from '../contracts.js';
import { parallelProvider } from './parallel.js';
import { exaProvider } from './exa.js';

/** Bind provider-specific option types once, at the registration boundary. */
export function registerSearchProvider<Options extends Record<string, unknown>>(
  definition: SearchProviderDefinition<Options>,
) {
  return {
    id: definition.id,
    label: definition.label,
    authentication: definition.authentication,
    defaults: definition.defaults,
    readOptionsSchema: definition.readOptionsSchema,
    writeOptionsSchema: definition.writeOptionsSchema,
    bind(options: Record<string, unknown> = definition.defaults.options) {
      const parsed = definition.readOptionsSchema.parse(options);
      return {
        getCapabilities: definition.getCapabilities.bind(definition, parsed),
        createBackend: definition.createBackend.bind(definition, parsed),
        checkConnection: definition.checkConnection?.bind(definition, parsed),
      };
    },
    connectionCheck: Boolean(definition.checkConnection),
  };
}

export type RegisteredSearchProvider = ReturnType<typeof registerSearchProvider>;

export const searchProviders: ReadonlyMap<string, RegisteredSearchProvider> = new Map([
  registerSearchProvider(parallelProvider), registerSearchProvider(exaProvider),
].map((provider) => [provider.id, provider]));
