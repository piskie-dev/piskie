import { appLog } from '@electron/observability/logging/app-log.js';
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
  const inherited = inheritedWorkerInference(input);
  if (!override) return inherited;
  return reconcileWorkerInference(
    input.type,
    { model: formatModelTarget(override.target), reasoning: structuredClone(override.reasoning) },
    inherited,
    inference
  );
}

/** The parent's actual model and reasoning at creation time. */
export function inheritedWorkerInference(input: WorkerInferenceInput): WorkerInferenceSelection {
  return { model: input.parentModel, reasoning: structuredClone(input.parentReasoning) };
}

/**
 * Preferences and the model catalog can drift apart outside the config kernel (hand-edited
 * files, remote catalog sync), so a preference whose model is gone must not fail Worker
 * creation: it falls back to the parent's model and reasoning. The inherited selection is
 * still asserted, so an unusable parent model fails loudly.
 * Also used after asynchronous creation waits, retaining the original selection while valid.
 */
export function reconcileWorkerInference(
  type: string,
  preferred: WorkerInferenceSelection,
  inherited: WorkerInferenceSelection,
  inference: InferenceSelectionPort
): WorkerInferenceSelection {
  try {
    inference.assertTarget(parseModelTargetReference(preferred.model));
  } catch (cause) {
    if (preferred.model === inherited.model) throw workerInferenceError(type, preferred, cause);
    appLog.warn({
      event: 'agent.worker.inference.fallback',
      message: 'Worker model preference is unavailable; inheriting the parent model',
      context: { scope: 'agent.worker', type, model: preferred.model, fallbackModel: inherited.model },
      error: cause,
    });
    return assertWorkerInference(type, inherited, inference);
  }
  return assertWorkerInference(type, preferred, inference);
}

/** Throws with the Worker type and model in the message; returns the selection when valid. */
export function assertWorkerInference(
  type: string,
  selection: WorkerInferenceSelection,
  inference: InferenceSelectionPort
): WorkerInferenceSelection {
  try {
    assertWorkerReasoningInput(selection.reasoning);
    const target = parseModelTargetReference(selection.model);
    inference.assertTarget(target);
    inference.resolveReasoning(target, selection.reasoning);
    return selection;
  } catch (cause) {
    throw workerInferenceError(type, selection, cause);
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

function workerInferenceError(type: string, selection: WorkerInferenceSelection, cause: unknown): Error {
  return new Error(
    `Worker ${type} (${selection.model}): ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause }
  );
}
