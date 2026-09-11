import type { ModelTarget } from './inference.js';
import type { ReasoningSelection } from './reasoning.js';

export interface WorkerTypeDescriptor {
  type: string;
  description: string;
}

export interface WorkerInferencePreferences {
  target: ModelTarget;
  reasoning: ReasoningSelection;
}

export interface WorkerPreferences {
  /** Optional remark shown only in Agent management; never an Agent identity or runtime name. */
  displayName?: string;
  /** Absence inherits both the parent's model and its actual reasoning selection. */
  inference?: WorkerInferencePreferences;
}

export interface WorkerPreferencesDocument {
  schemaVersion: 1;
  revision: number;
  profiles: Record<string, WorkerPreferences>;
}
