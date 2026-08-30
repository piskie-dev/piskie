import { ConfigDomainRegistry } from '../core/registry.js';
import type { InferenceControlPlane } from '../../inference/control/control-plane.js';
import type {
  InferenceSelections,
  InferenceSelectionStore,
} from '../../inference/control/selection-store.js';
import {
  emptyConfigDomainIntegrations,
  type ConfigDomainIntegrations,
} from '../domains/integrations.js';
import { createManifestConfigDomains } from '../domains/manifest.js';
import { ConfigHost, type ConfigHostOptions } from './config-host.js';

export interface ConfigDomainCompositionDependencies {
  rootDirectory?: string;
  inference: InferenceControlPlane;
  selections?: InferenceSelectionStore;
  integrations?: ConfigDomainIntegrations;
  onSelectionsChanged?: (selections: InferenceSelections) => void | Promise<void>;
  onHistoryMaintenanceError?: (error: unknown) => void;
}

export function createConfigDomainRegistry(
  dependencies: ConfigDomainCompositionDependencies,
): ConfigDomainRegistry {
  const registry = new ConfigDomainRegistry();
  const integrations = dependencies.integrations ?? emptyConfigDomainIntegrations();
  const readDomain = async (domain: string): Promise<unknown> => {
    const adapter = registry.get(domain);
    if (!adapter.show) throw new Error(`Config domain ${domain} does not support show`);
    return adapter.show();
  };
  const domains = createManifestConfigDomains({
    rootDirectory: dependencies.rootDirectory,
    inference: dependencies.inference,
    selections: dependencies.selections,
    integrations,
    readDomain,
    onSelectionsChanged: dependencies.onSelectionsChanged,
  });
  for (const domain of domains) registry.register(domain);
  return registry;
}

export function createConfigHost(
  dependencies: ConfigDomainCompositionDependencies,
  options?: ConfigHostOptions,
): ConfigHost {
  return new ConfigHost(createConfigDomainRegistry(dependencies), options);
}
