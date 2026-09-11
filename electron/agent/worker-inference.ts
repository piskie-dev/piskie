import type { WorkerPreferencesDocument } from '../../shared/types/worker-preferences.js';
import type { ReasoningSelection } from '../../shared/types/reasoning.js';
import type { AgentInferencePort } from '../inference/application/agent-inference-port.js';
import {
  formatModelTarget,
  parseModelTargetReference,
} from '../inference/execution/model-target.js';

export interface WorkerInferenceInput {
  type: string;
  parentModel: string;
  parentReasoning: ReasoningSelection;
}
export interface WorkerInferenceSelection {
  model: string;
  reasoning: ReasoningSelection;
}
export type WorkerInferenceResolver = (
  input: WorkerInferenceInput
) => Promise<WorkerInferenceSelection>;
type InferenceSelectionPort = Pick<AgentInferencePort, 'assertTarget' | 'resolveReasoning'>;

/** Resolve once at creation; preferences never mutate a live Runtime or its Spec. */
export function resolveWorkerInference(
  input: WorkerInferenceInput,
  preferences: WorkerPreferencesDocument,
  inference: InferenceSelectionPort
): WorkerInferenceSelection {
  const override = Object.hasOwn(preferences.profiles, input.type)
    ? preferences.profiles[input.type]?.inference
    : undefined;
  const selection = {
    model: override ? formatModelTarget(override.target) : input.parentModel,
    reasoning: structuredClone(override?.reasoning ?? input.parentReasoning),
  };
  assertWorkerInference(input.type, selection, inference);
  return selection;
}

/** Also used after browser handoff waits, retaining the original creation selection. */
export function assertWorkerInference(
  type: string,
  selection: WorkerInferenceSelection,
  inference: InferenceSelectionPort
): void {
  try {
    assertWorkerReasoningInput(selection.reasoning);
    const target = parseModelTargetReference(selection.model);
    inference.assertTarget(target);
    inference.resolveReasoning(target, selection.reasoning);
  } catch (cause) {
    throw new Error(
      `Worker ${type} (${selection.model}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}

export function assertWorkerReasoningInput(selection?: ReasoningSelection): void {
  if (
    selection?.kind === 'budget' &&
    (!Number.isInteger(selection.tokens) || selection.tokens <= 0)
  ) {
    throw new Error('Worker reasoning budget must be a positive integer');
  }
}
