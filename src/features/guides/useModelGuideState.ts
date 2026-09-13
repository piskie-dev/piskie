import { getAvailableModelOptions, useInferenceStore } from '../../store/inferenceStore';

export function useModelGuideState() {
  const ready = useInferenceStore((s) => s.config !== null && !s.isLoading && !s.error);
  const hasModel = useInferenceStore((s) => getAvailableModelOptions(s.config, s.models.ai, s.availableTargets.ai).length > 0);
  return { ready, hasModel };
}
