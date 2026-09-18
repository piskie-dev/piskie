import path from 'node:path';
import { powerMonitor } from 'electron';
import { startDirectorRun } from '../../agent/launch/start-director-run.js';
import { createChangeChannel, type ChangeSource } from '../../core/change-channel.js';
import type { ScheduleStore } from '../../core/storage/schedule-store.js';
import type { TaskDefinitionStore } from '../../core/storage/task-definition-store.js';
import { appLog } from '../../observability/logging/app-log.js';
import {
  ScheduleHistoryStore,
  Scheduler,
  ScheduleStateStore,
} from '../../schedules/index.js';
import type { AgentService } from '../../services/agent.service.js';
import { createUuid } from '../../../shared/utils/identifiers.js';
import type { ScheduleNotice } from '../../../shared/types/schedules.js';
import type { RuntimeComponent } from '../component-manifest.js';

export interface ScheduleStateChange {
  at: string;
}

/** 能力层拿到的调度器句柄：引擎、两份存储与两路变化源。 */
export interface SchedulerHandle {
  readonly scheduler: Scheduler;
  readonly state: ScheduleStateStore;
  readonly history: ScheduleHistoryStore;
  readonly notices: ChangeSource<ScheduleNotice>;
  readonly stateChanges: ChangeSource<ScheduleStateChange>;
}

export function createSchedulerComponent(options: {
  userDataDirectory: string;
  agentService: AgentService;
  definitions: ScheduleStore;
  templates: TaskDefinitionStore;
}): RuntimeComponent<SchedulerHandle> {
  let handle: SchedulerHandle | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  let detachPowerMonitor: (() => void) | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      detachPowerMonitor?.();
      detachPowerMonitor = undefined;
      handle?.scheduler.stop();
      await handle?.scheduler.idle();
      await handle?.state.flush();
      await handle?.history.flush();
      closed = true;
    })();
    return closePromise;
  };

  return {
    id: 'scheduler',
    requirement: 'required',
    dependsOn: ['agent'],
    async start(_context, scope) {
      scope.register({
        kind: 'custom',
        label: 'scheduler',
        close,
        inspect: () => (!handle || closed ? 'closed' : 'live'),
      });
      const root = path.join(options.userDataDirectory, 'runtime-state', 'schedules');
      const state = new ScheduleStateStore(path.join(root, 'state.json'));
      const history = new ScheduleHistoryStore(path.join(root, 'history'));
      const { recoveredFrom } = await state.load();
      if (recoveredFrom) {
        appLog.warn({
          event: 'schedules.state.recovered',
          message: 'Schedule state file was unreadable and has been reset',
          context: { scope: 'schedules', recoveredFrom },
        });
      }
      const notices = createChangeChannel<ScheduleNotice>();
      const stateChanges = createChangeChannel<ScheduleStateChange>();
      const scheduler = new Scheduler({
        definitions: options.definitions,
        templates: options.templates,
        agents: {
          startRun: async (runConfig, launch) => {
            const started = await startDirectorRun(runConfig, launch);
            return { agentId: started.agentId };
          },
          inject: (agentId, content) => options.agentService.injectEventToAgent(agentId, {
            id: createUuid(),
            timestamp: new Date(),
            source: 'system',
            content,
          }),
          controlState: (agentId) => options.agentService.getControlState(agentId),
          stop: async (agentId) => {
            await options.agentService.stopAgent(agentId);
          },
        },
        state,
        history,
        notify: (notice) => notices.sink.publish(notice),
        onStateChanged: () => stateChanges.sink.publish({ at: new Date().toISOString() }),
      });
      handle = {
        scheduler,
        state,
        history,
        notices: notices.source,
        stateChanges: stateChanges.source,
      };
      await scheduler.start();
      // 休眠唤醒后立即评估一次，不必等心跳。
      try {
        const onResume = (): void => scheduler.requestTick();
        powerMonitor.on('resume', onResume);
        detachPowerMonitor = () => powerMonitor.off('resume', onResume);
      } catch (error) {
        appLog.warn({
          event: 'schedules.power_monitor.unavailable',
          message: 'Power monitor is unavailable; relying on the heartbeat after resume',
          context: { scope: 'schedules' },
          error,
        });
      }
      return handle;
    },
    stop: close,
    async verifyStopped() {
      return { state: !handle || closed ? 'stopped' : 'live' };
    },
  };
}
