import { useEffect, useRef } from 'react';
import { useIncidentStore } from '../../store/incidentStore';
import { pushToast } from '../toasts';
import { selectVisibleIncidents } from './selectors';

const DEDUP_WINDOW_MS = 10_000;

export function IncidentToastBridge() {
  const incidents = useIncidentStore((state) => state.incidents);
  const shownIds = useRef(new Set<string>());
  const recentCodes = useRef(new Map<string, number>());

  useEffect(() => {
    const now = Date.now();
    for (const incident of selectVisibleIncidents(incidents)) {
      if (shownIds.current.has(incident.id)) continue;
      const dedupKey = incident.details?.code || incident.category;
      const lastShown = recentCodes.current.get(dedupKey);
      if (lastShown && now - lastShown < DEDUP_WINDOW_MS) continue;

      shownIds.current.add(incident.id);
      recentCodes.current.set(dedupKey, now);
      if (incident.severity === 'critical') {
        pushToast({
          id: incident.id,
          tone: 'critical',
          title: incident.message,
          detail: incident.suggestions?.join(' · '),
          durationMs: 0,
        });
      } else if (incident.severity === 'error') {
        pushToast({
          id: incident.id,
          tone: 'error',
          title: incident.message,
          detail: incident.suggestions?.join(' · '),
          durationMs: 10_000,
        });
      } else {
        pushToast({
          id: incident.id,
          tone: 'warning',
          title: incident.message,
          durationMs: 5_000,
        });
      }
    }
  }, [incidents]);

  return null;
}
