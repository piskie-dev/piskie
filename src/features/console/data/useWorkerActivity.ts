import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTranscript } from './useTranscript';
import { useWorkerVM } from './vm';
import { resolveWorkerActivity } from './workerActivity';

export function useWorkerActivity(mainAgentId: string, workerId: string) {
  const { t } = useTranslation();
  const worker = useWorkerVM(mainAgentId, workerId);
  const parent = useTranscript(mainAgentId);
  const child = useTranscript(worker ? workerId : undefined);
  return useMemo(() => resolveWorkerActivity(worker, child.nodes, parent.nodes, workerId, t),
    [child.nodes, parent.nodes, t, worker, workerId]);
}
