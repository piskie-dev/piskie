import type { InferenceControlPlane } from '../../inference/control/control-plane.js';
import type {
  InferenceSelections,
  InferenceSelectionStore,
} from '../../inference/control/selection-store.js';
import type { ConfigDomainAdapter } from '../contracts/domain.js';
import { createAppSettingsDomain } from './app-settings.adapter.js';
import { createBrowserEnvironmentsDomain } from './browser-profiles.adapter.js';
import { createTaskDefinitionsDomain } from './task-definitions.adapter.js';
import { createImBotsDomain } from './im-bots.adapter.js';
import { createInferenceSelectionsDomain } from './inference-selections.adapter.js';
import { createInferenceDomain } from './inference.adapter.js';
import type {
  ConfigDomainIntegrations,
  ConfigDomainReader,
} from './integrations.js';
import { createMcpDomain } from '../../mcp/config/domain.js';
import { createModelCatalogDomain } from './model-catalog.adapter.js';
import { createProxiesDomain } from './proxies.adapter.js';

export interface ConfigDomainManifestContext {
  rootDirectory?: string;
  inference: InferenceControlPlane;
  selections?: InferenceSelectionStore;
  integrations: ConfigDomainIntegrations;
  readDomain: ConfigDomainReader;
  onSelectionsChanged?: (selections: InferenceSelections) => void | Promise<void>;
}

type ConfigDomainFactory = (
  context: ConfigDomainManifestContext,
) => ConfigDomainAdapter | undefined;

interface ManagedDomainContext extends ConfigDomainManifestContext {
  rootDirectory: string;
  selections: InferenceSelectionStore;
}

export class ConfigDomainManifestError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_DOMAIN_UNREGISTERED'
      | 'CONFIG_DOMAIN_SOURCE_MISSING'
      | 'CONFIG_DOMAIN_ID_MISMATCH',
    message: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ConfigDomainManifestError';
  }
}

/** The only production registration source for Config Domains. */
export const CONFIG_DOMAIN_MANIFEST = {
  'app-settings': managed((context) => createAppSettingsDomain(
    context.rootDirectory,
    context.integrations.appSettings,
  )),
  'browser-profiles': managed((context) => createBrowserEnvironmentsDomain(
    context.rootDirectory,
    context.integrations.browserEnvironments,
    context.readDomain,
  )),
  'task-definitions': managed((context) => createTaskDefinitionsDomain(
    context.rootDirectory,
    context.integrations.taskDefinitions,
    context.readDomain,
  )),
  'im-bots': managed((context) => createImBotsDomain(
    context.rootDirectory,
    context.integrations.imBots,
    context.readDomain,
  )),
  inference: (context) => createInferenceDomain(
    context.inference,
    isManagedContext(context) ? context.readDomain : undefined,
  ),
  'inference-selections': managed((context) => createInferenceSelectionsDomain(
    context.rootDirectory,
    context.selections,
    context.inference,
    context.readDomain,
    context.onSelectionsChanged,
  )),
  mcp: managed((context) => createMcpDomain(
    context.rootDirectory,
    context.integrations.mcp,
    context.readDomain,
  )),
  'model-catalog': managed((context) => createModelCatalogDomain(
    context.rootDirectory,
    context.inference,
    context.readDomain,
  )),
  proxies: managed((context) => createProxiesDomain(
    context.rootDirectory,
    context.integrations.proxies,
    context.readDomain,
  )),
} as const satisfies Record<string, ConfigDomainFactory>;

export type ConfigDomainManifestId = keyof typeof CONFIG_DOMAIN_MANIFEST;

export const CONFIG_DOMAIN_IDS = Object.freeze(
  Object.keys(CONFIG_DOMAIN_MANIFEST) as ConfigDomainManifestId[],
);

export function createManifestConfigDomains(
  context: ConfigDomainManifestContext,
): ConfigDomainAdapter[] {
  return manifestEntries().flatMap(([expectedId, factory]) => {
    const domain = factory(context);
    if (!domain) return [];
    if (domain.contract.id !== expectedId) {
      throw new ConfigDomainManifestError(
        'CONFIG_DOMAIN_ID_MISMATCH',
        `Config Domain manifest key ${expectedId} does not match Contract ID ${domain.contract.id}`,
        { expectedId, actualId: domain.contract.id },
      );
    }
    return [domain];
  });
}

/** Used by the source-level contract test so a new *.adapter.ts cannot be forgotten. */
export function assertConfigDomainManifestSources(
  sourceFiles: readonly string[],
  manifestIds: readonly string[] = CONFIG_DOMAIN_IDS,
): void {
  const sourceIds = [...new Set(sourceFiles
    .filter((file) => file.endsWith('.adapter.ts'))
    .map((file) => file.slice(file.lastIndexOf('/') + 1, -'.adapter.ts'.length)))]
    .sort();
  const registered = [...new Set(manifestIds)].sort();
  const unregistered = sourceIds.filter((id) => !registered.includes(id));
  if (unregistered.length > 0) {
    throw new ConfigDomainManifestError(
      'CONFIG_DOMAIN_UNREGISTERED',
      `Config Domain adapter is missing from the manifest: ${unregistered.join(', ')}`,
      { unregistered },
    );
  }

  const missingSources = registered.filter((id) => !sourceIds.includes(id));
  if (missingSources.length > 0) {
    throw new ConfigDomainManifestError(
      'CONFIG_DOMAIN_SOURCE_MISSING',
      `Config Domain manifest entry has no adapter source: ${missingSources.join(', ')}`,
      { missingSources },
    );
  }
}

function managed(
  factory: (context: ManagedDomainContext) => ConfigDomainAdapter,
): ConfigDomainFactory {
  return (context) => isManagedContext(context) ? factory(context) : undefined;
}

function isManagedContext(
  context: ConfigDomainManifestContext,
): context is ManagedDomainContext {
  return typeof context.rootDirectory === 'string' && context.selections !== undefined;
}

function manifestEntries(): Array<[ConfigDomainManifestId, ConfigDomainFactory]> {
  return Object.entries(CONFIG_DOMAIN_MANIFEST) as Array<[
    ConfigDomainManifestId,
    ConfigDomainFactory,
  ]>;
}
