import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getAvailableModelOptions, useInferenceStore } from '../../store/inferenceStore';
import { resolvePresentationText } from '../../i18n/presentationText';
import { useWorkerPreferencesStore } from './worker-preferences-store';
import { AgentManagementView } from './AgentManagementView';

export function AgentManagementPage() {
  const state = useWorkerPreferencesStore();
  const config = useInferenceStore((s) => s.config);
  const models = useInferenceStore((s) => s.models.ai);
  const targets = useInferenceStore((s) => s.availableTargets.ai);
  const inferenceError = useInferenceStore((s) => s.error);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const groups = useMemo(
    () => getAvailableModelOptions(config, models, targets),
    [config, models, targets]
  );
  useEffect(() => {
    void useWorkerPreferencesStore.getState().refresh();
    void useInferenceStore.getState().refresh();
  }, []);
  return (
    <AgentManagementView
      {...state}
      groups={groups}
      modelError={inferenceError ? resolvePresentationText(inferenceError, t) : null}
      onConfigureModels={() => navigate('/preferences?sect=ai')}
      onRefresh={() => {
        void state.refresh();
        void useInferenceStore.getState().refresh();
      }}
    />
  );
}
