import type { ReasoningProfile, ReasoningSelection } from './reasoning.js';

export interface ModelTarget {
  providerId: string;
  modelId: string;
}

export type OpenAiWireApi = 'responses' | 'chat_completions';

export const DEFAULT_OPENAI_WIRE_API: OpenAiWireApi = 'responses';

export type PlainInferenceAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; value: string }
  | { kind: 'api_key'; header: string; value: string }
  | { kind: 'basic'; username: string; password: string }
  | {
      kind: 'aws';
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      region: string;
    };

export interface InferenceModelBinding {
  catalogId: string;
  upstreamId: string;
  enabled: boolean;
  defaultReasoning?: ReasoningSelection;
  options: Record<string, unknown>;
}

export interface InferenceProviderInstance {
  displayName: string;
  driver: string;
  enabled: boolean;
  connection: {
    baseUrl: string;
    auth: PlainInferenceAuth;
    headers: Record<string, string>;
    proxyId: string | null;
  };
  models: Record<string, InferenceModelBinding>;
  driverOptions: Record<string, unknown>;
}

export interface InferenceConfig {
  schemaVersion: 1;
  revision: number;
  providers: Record<string, InferenceProviderInstance>;
  policies: {
    ai: {
      maxAttempts: number;
      connectTimeoutMs: number;
      streamIdleTimeoutMs: number;
      retryBaseDelayMs: number;
    };
    image: {
      maxSubmitAttempts: number;
      submitTimeoutMs: number;
      operationTimeoutMs: number;
      allowResubmitAfterAccepted: false;
    };
  };
}

export interface InferenceSelections {
  schemaVersion: 1;
  revision: number;
  ai?: ModelTarget;
  image?: ModelTarget;
}

export interface InferenceModelCapabilities {
  streaming?: boolean;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  structuredOutput?: boolean;
  generate?: boolean;
  edit?: boolean;
  referenceImages?: boolean;
  mask?: boolean;
}

export interface InferenceModelDefinition {
  id: string;
  displayName: string;
  kind: 'ai' | 'image';
  family?: string;
  releaseDate?: string;
  lifecycle: 'preview' | 'active' | 'deprecated' | 'retired';
  compatibleDrivers: string[];
  inputModalities: string[];
  outputModalities: string[];
  capabilities: InferenceModelCapabilities;
  reasoning?: ReasoningProfile;
  limits: {
    contextWindow?: number;
    maxOutputTokens?: number;
    maxImages?: number;
    sizes?: string[];
    formats?: Array<'png' | 'jpeg' | 'webp'>;
  };
  pricing?: Record<string, number>;
  source: {
    kind: 'bundled' | 'local' | 'remote';
    version: string;
    updatedAt?: string;
  };
  operationCapability?: 'supported' | 'unsupported' | 'unknown';
}

export type InferenceCatalogModelInput = Omit<
  InferenceModelDefinition,
  'source' | 'operationCapability'
>;

export interface InferenceLocalCatalogDocument {
  version: string;
  revision: number;
  models: Array<Partial<InferenceModelDefinition> & Pick<InferenceModelDefinition, 'id'>>;
}

export interface InferenceAvailableTarget extends ModelTarget {
  catalogId: string;
}

export interface InferenceAvailabilityIssue {
  stage: 'schema' | 'semantic';
  code: string;
  path: string;
  message: string;
  severity?: 'error' | 'warning';
}

export interface InferenceModelQueryResult {
  catalogVersion: string;
  gateway: 'ai' | 'image';
  operation?: 'generate' | 'edit';
  models: InferenceModelDefinition[];
  availableTargets: InferenceAvailableTarget[];
  issues: InferenceAvailabilityIssue[];
}

export interface InferenceDriverSummary {
  id: string;
  supportedGateways: Array<'ai' | 'image'>;
  acceptedAuth: PlainInferenceAuth['kind'][];
}

export interface InferenceDriverSchema extends InferenceDriverSummary {
  providerOptions: Record<string, unknown>;
  modelOptions: Record<string, unknown>;
}

export interface InferenceComfyFieldBinding {
  nodeId: string;
  field: string;
}

export interface InferenceComfyWorkflowAsset {
  id: string;
  sha256: string;
}

export interface InferenceComfyWorkflowInspection extends InferenceComfyWorkflowAsset {
  nodes: Array<{
    nodeId: string;
    classType: string;
    fields: string[];
    title?: string;
  }>;
}

export interface InferenceComfyWorkflowBindingCandidates {
  prompt: InferenceComfyFieldBinding[];
  seed: InferenceComfyFieldBinding[];
  width: InferenceComfyFieldBinding[];
  height: InferenceComfyFieldBinding[];
  batch: InferenceComfyFieldBinding[];
  inputImages: InferenceComfyFieldBinding[];
  mask: InferenceComfyFieldBinding[];
}

export interface InferenceComfyWorkflowBindingReport {
  valid: boolean;
  issues: Array<{
    code: string;
    path: string;
    message: string;
  }>;
}

export interface InferenceProbeReceipt {
  driverId: string;
  providerId: string;
  modelId?: string;
  level: 'connectivity' | 'smoke';
  success: boolean;
  startedAt: string;
  completedAt: string;
  status?: number;
  requestId?: string;
  artifacts?: InferenceImageArtifact[];
  error?: unknown;
}

export interface InferenceImageArtifact {
  artifactId: string;
  mimeType: string;
  width?: number;
  height?: number;
  byteLength?: number;
  sha256?: string;
  revisedPrompt?: string;
  seed?: number;
}

export interface InferenceArtifactPreview {
  artifactId: string;
  mimeType: string;
  dataUrl: string;
}
