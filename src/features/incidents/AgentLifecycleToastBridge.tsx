import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentControl } from '../../renderer-runtime/hooks';
import { pushToast } from '../toasts';

export function AgentLifecycleToastBridge() {
  const { t } = useTranslation();
  const controlStates = useAgentControl((state) => state.agentsById);
  const previous = useRef(new Map<string, { name?: string; description?: string }>());

  useEffect(() => {
    for (const [agentId, snapshot] of previous.current.entries()) {
      if (agentId in controlStates) continue;
      pushToast({
        id: `agent-stopped-${agentId}`,
        tone: 'info',
        title: t('sharedUi.incident.taskStopped'),
        detail: snapshot.description || snapshot.name || t('sharedUi.incident.taskCompleted'),
        durationMs: 10_000,
      });
      previous.current.delete(agentId);
    }

    for (const [agentId, state] of Object.entries(controlStates)) {
      previous.current.set(agentId, {
        name: state.runConfig.name,
        description: state.runConfig.description,
      });
    }
  }, [controlStates, t]);

  return null;
}
