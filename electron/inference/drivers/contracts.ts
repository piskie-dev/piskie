import type { CatalogSnapshot, ModelDefinition } from '../catalog/contracts.js';
import type { ProviderInstance, ModelBinding, PlainAuth } from '../control/config-schema.js';
import type { CompiledTarget } from '../execution/runtime-snapshot.js';
import type { ImageArtifact } from '../image/contracts.js';

export type ProbeLevel = 'connectivity' | 'smoke';

export interface DriverValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface DriverManifest {
  id: string;
  supportedGateways: readonly ('ai' | 'image')[];
  acceptedAuth: readonly PlainAuth['kind'][];
  providerConfigSchema: Record<string, unknown>;
  modelOptionsSchema: Record<string, unknown>;
}

export interface DriverCompileInput {
  providerId: string;
  provider: ProviderInstance;
  modelId: string;
  binding: ModelBinding;
  catalogModel: ModelDefinition;
  catalog: CatalogSnapshot;
  configRevision: number;
}

export interface ProviderConnectivityProbeInput {
  providerId: string;
  provider: ProviderInstance;
  signal: AbortSignal;
}

export interface ProbeReceipt {
  driverId: string;
  providerId: string;
  modelId?: string;
  level: ProbeLevel;
  success: boolean;
  startedAt: string;
  completedAt: string;
  status?: number;
  requestId?: string;
  artifacts?: readonly ImageArtifact[];
  error?: unknown;
}

export interface InferenceDriver {
  manifest: DriverManifest;
  validateProviderOptions(options: Readonly<Record<string, unknown>>): readonly DriverValidationIssue[];
  validateModelOptions(options: Readonly<Record<string, unknown>>): readonly DriverValidationIssue[];
  compile(input: DriverCompileInput): CompiledTarget;
  probeConnectivity(input: ProviderConnectivityProbeInput): Promise<ProbeReceipt>;
}
