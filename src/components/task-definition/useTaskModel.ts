import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelTarget } from '../../../shared/types/inference';
import { resolvePresentationText } from '../../i18n/presentationText';
import { getAvailableModelOptions, useInferenceStore } from '../../store/inferenceStore';

export function useTaskModel(model?: ModelTarget) {
  const { t } = useTranslation();
  const config = useInferenceStore((state) => state.config);
  const models = useInferenceStore((state) => state.models.ai);
  const available = useInferenceStore((state) => state.availableTargets.ai);
  const defaultModel = useInferenceStore((state) => state.selections?.ai);
  const loading = useInferenceStore((state) => state.isLoading);
  const error = useInferenceStore((state) => state.error);
  const refresh = useInferenceStore((state) => state.refresh);
  const subscribe = useInferenceStore((state) => state.subscribeToConfigChanges);
  useEffect(() => {
    void refresh();
    return subscribe();
  }, [refresh, subscribe]);
  const groups = useMemo(() => getAvailableModelOptions(config, models, available), [config, models, available]);
  const describe = (target?: ModelTarget) => {
    const provider = target && config?.providers[target.providerId];
    const binding = target && provider?.models[target.modelId];
    const definition = binding && models.find((entry) => entry.id === binding.catalogId);
    const selectable = !!target && available.some((entry) => (
      entry.providerId === target.providerId && entry.modelId === target.modelId
    ));
    const label = target
      ? `${provider?.displayName || target.providerId} / ${definition?.displayName || target.modelId}`
      : t('console.taskModelMissingDefault');
    const status = loading ? t('console.taskModelLoading')
      : error ? resolvePresentationText(error, (key, values) => t(key, values ?? {}))
        : target && !selectable ? t('console.taskModelUnavailable') : '';
    return { label, status, summary: status ? `${label} · ${status}` : label,
      reference: target ? `${target.providerId} / ${target.modelId}` : undefined,
      unavailable: !selectable };
  };
  return {
    groups,
    current: describe(model ?? defaultModel),
    globalDefault: describe(defaultModel),
    source: model ? t('console.taskModelFixed') : t('console.taskModelFollow'),
  };
}
