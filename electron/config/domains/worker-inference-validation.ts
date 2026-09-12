import type { ConfigValidationIssue } from '../../../shared/types/config.js';
import type { WorkerPreferencesDocument } from '../../../shared/types/worker-preferences.js';
import type { InferenceControlPlane } from '../../inference/control/control-plane.js';

export async function validateWorkerInference(
  inference: InferenceControlPlane,
  document: WorkerPreferencesDocument,
  candidate?: Parameters<InferenceControlPlane['validateAiSelections']>[1]
): Promise<ConfigValidationIssue[]> {
  const references = Object.entries(document.profiles).flatMap(([type, preferences]) =>
    preferences.inference ? [{ ...preferences.inference, type }] : []
  );
  const issues = await inference.validateAiSelections(references, candidate);
  return issues.map(({ index, code }) => {
    const reference = references[index]!;
    const target = `${reference.target.providerId}/${reference.target.modelId}`;
    return {
      stage: 'reference',
      code: `WORKER_${code}`,
      path: `/profiles/${escapePointer(reference.type)}/inference/${code === 'MODEL_UNAVAILABLE' ? 'target' : 'reasoning'}`,
      details: { type: reference.type, target: reference.target },
      message:
        code === 'MODEL_UNAVAILABLE'
          ? `Worker ${reference.type} references unavailable AI model ${target}.`
          : `Worker ${reference.type} has unsupported reasoning for ${target}.`,
    };
  });
}

export function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
