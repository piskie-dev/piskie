import type {
  InferenceArtifactPreview,
  InferenceComfyWorkflowAsset,
  InferenceComfyWorkflowBindingCandidates,
  InferenceComfyWorkflowBindingReport,
  InferenceComfyWorkflowInspection,
  InferenceDriverSchema,
  InferenceDriverSummary,
  InferenceModelQueryResult,
  InferenceProbeReceipt,
} from '../types/index.js';

export const INFERENCE_OPERATIONS = Object.freeze({
  listDrivers: 'inference.listDrivers',
  driverSchema: 'inference.driverSchema',
  queryModels: 'inference.queryModels',
  importWorkflow: 'inference.importWorkflow',
  inspectWorkflow: 'inference.inspectWorkflow',
  detectBindings: 'inference.detectBindings',
  validateBindings: 'inference.validateBindings',
  probe: 'inference.probe',
  artifact: 'inference.artifact',
} as const);

export interface InferenceClient {
  listDrivers(): Promise<InferenceDriverSummary[]>;
  driverSchema(driverId: string): Promise<InferenceDriverSchema>;
  queryModels(input: {
    gateway: 'ai' | 'image';
    operation?: 'generate' | 'edit';
  }): Promise<InferenceModelQueryResult>;
  importWorkflow(source: string): Promise<InferenceComfyWorkflowAsset>;
  inspectWorkflow(assetId: string): Promise<InferenceComfyWorkflowInspection>;
  detectBindings(assetId: string): Promise<InferenceComfyWorkflowBindingCandidates>;
  validateBindings(input: {
    assetId: string;
    bindings: Record<string, unknown>;
    outputNodeIds: string[];
  }): Promise<InferenceComfyWorkflowBindingReport>;
  probe(input: {
    level: 'connectivity' | 'smoke';
    target?: { providerId?: string; modelId?: string };
  }): Promise<InferenceProbeReceipt[]>;
  artifact(artifactId: string): Promise<InferenceArtifactPreview>;
}
