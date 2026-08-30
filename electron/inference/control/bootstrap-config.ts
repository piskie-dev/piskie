import { ensureBundledInferenceCatalog } from '../catalog/bundled-source.js';
import { CanonicalCatalogSource } from '../catalog/canonical-source.js';
import type { CatalogOverlayDocument } from '../catalog/contracts.js';
import type { DriverRegistry } from '../drivers/registry.js';
import { compileInferenceConfig } from './compiler.js';
import {
  InferenceConfigRepository,
  inferenceConfigPaths,
} from './config-repository.js';
import {
  DEFAULT_AI_RETRY_BASE_DELAY_MS,
  type InferenceConfig,
} from './config-schema.js';

export interface BootstrapInferenceConfigOptions {
  rootDirectory: string;
  drivers: DriverRegistry;
  now?: () => Date;
  onHistoryMaintenanceError?: (error: unknown) => void;
}

export interface BootstrapInferenceConfigResult {
  created: boolean;
  revision: number;
}

export async function bootstrapInferenceConfig(
  options: BootstrapInferenceConfigOptions,
): Promise<BootstrapInferenceConfigResult> {
  const paths = inferenceConfigPaths(options.rootDirectory);
  const repository = new InferenceConfigRepository(paths);
  await ensureBundledInferenceCatalog(options.rootDirectory);
  if (await repository.exists()) {
    try {
      await repository.pruneHistory();
    } catch (error) {
      try {
        options.onHistoryMaintenanceError?.(error);
      } catch {
        // History diagnostics must not block an otherwise valid config startup.
      }
    }
    return { created: false, revision: (await repository.read()).revision };
  }

  const config = emptyInferenceConfig();
  const emptyCatalog: CatalogOverlayDocument = {
    version: 'local:0',
    revision: 0,
    models: [],
  };
  const catalog = await new CanonicalCatalogSource({
    rootDirectory: options.rootDirectory,
    now: options.now,
  }).loadCandidate(emptyCatalog);
  compileInferenceConfig(config, catalog, options.drivers, options.now);
  await repository.initialize(config);
  return { created: true, revision: config.revision };
}

export function emptyInferenceConfig(): InferenceConfig {
  return {
    schemaVersion: 1,
    revision: 0,
    providers: {},
    policies: {
      ai: {
        maxAttempts: 3,
        connectTimeoutMs: 30_000,
        streamIdleTimeoutMs: 300_000,
        retryBaseDelayMs: DEFAULT_AI_RETRY_BASE_DELAY_MS,
      },
      image: {
        maxSubmitAttempts: 2,
        submitTimeoutMs: 60_000,
        operationTimeoutMs: 600_000,
        allowResubmitAfterAccepted: false,
      },
    },
  };
}
