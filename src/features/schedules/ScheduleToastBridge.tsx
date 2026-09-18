import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { createConsoleHeaderAction } from '../console/shell/headerAction';
import { useRendererRuntime } from '../../renderer-runtime/hooks';
import { pushToast } from '../toasts';
import { describeSuspension } from './format';

/** 订阅 `schedules.changes` 的通知：触发成功给 info 并可跳到会话；系统挂起给 warning 带原因。 */
export function ScheduleToastBridge() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const runtime = useRendererRuntime();

  useEffect(() => runtime.schedules.onNotice((notice) => {
    if (notice.kind === 'started') {
      pushToast({
        id: `schedule-started-${notice.agentId}`,
        tone: 'info',
        title: t('schedulesUi.toast.started', { name: notice.name }),
        detail: t('schedulesUi.toast.startedDetail'),
        durationMs: 10_000,
        action: {
          label: t('schedulesUi.launch.openSession'),
          run: () => navigate('/console', {
            state: { consoleAction: createConsoleHeaderAction({ kind: 'reveal', target: { agentId: notice.agentId } }) },
          }),
        },
      });
      return;
    }
    pushToast({
      id: `schedule-suspended-${notice.scheduleId}`,
      tone: 'warning',
      title: t('schedulesUi.toast.suspended', { name: notice.name }),
      detail: describeSuspension(notice.suspension, t),
      durationMs: 0,
    });
  }), [navigate, runtime, t]);

  return null;
}
