import type { TFunction } from 'i18next';

export function formatActivityDuration(durationMs: number, t: TFunction): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return t('sessionWorkbenchUi.agentActivity.durationHours', { hours, minutes, seconds });
  }
  if (minutes > 0) {
    return t('sessionWorkbenchUi.agentActivity.durationMinutes', { minutes, seconds });
  }
  return t('sessionWorkbenchUi.agentActivity.durationSeconds', { seconds });
}
