import { ChevronRight, Pencil, Play, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import task from '../../components/task-definition/taskDefinitionModal.module.css';
import launcher from '../console/shell/taskDefinitionLauncher.module.css';
import sidebar from '../console/content/threads.module.css';
import thread from '../console/content/thread.module.css';
import transcript from '../console/content/Transcript.module.css';
import activeText from '../console/content/activeText.module.css';
import { OrbIndicator } from '../console/content/OrbIndicator';
import { StatusBadge } from '../console/chrome/StatusBadge';
import { interval, typedText } from './planTimeline';
import type { BusinessFrameProps } from './SceneStage';
import s from './businessScenes.module.css';

export function TemplateGuideFrame({ phase, time }: BusinessFrameProps) {
  const { t } = useTranslation();
  const name = t('guides.workflows.templates.name');
  const showingLauncher = phase === 0 || phase === 4;
  const showingRun = phase === 3 || phase === 5;
  return (
    <div
      className={s.templates}
      data-guide-source={
        showingLauncher
          ? 'TaskDefinitionLauncher'
          : showingRun ? 'ThreadCell/AgentActivityRow' : 'TaskDefinitionModal/LoadoutRail'
      }
    >
      {showingLauncher ? (
        <div className={s.templateReuse}>
          {phase === 4 && <p className={s.templateHint}>{t('guides.workflows.templates.laterReuseHint')}</p>}
          <div className={s.launcherCrop}>
            <span className={sidebar.actionButton}>
              <Play size={14} />
              {t('sessionWorkbenchUi.sidebar.startTask')}
            </span>
            <div className={`${launcher.panel} ${s.launcherPanel}`}>
              <header className={launcher.head}>
                <span className={launcher.title}>{t('sessionWorkbenchUi.launcher.heading')}</span>
                <span className={launcher.count}>{phase === 0 ? 0 : 1}</span>
              </header>
              <div className={launcher.list}>
                {phase === 0 ? (
                  <div className={launcher.empty}>{t('sessionWorkbenchUi.launcher.noMatches')}</div>
                ) : (
                  <div className={launcher.row}>
                    <span className={launcher.rowStart} data-demo-target="true">
                      <span className={launcher.rowIcon}>
                        <Play size={12} />
                      </span>
                      <span className={launcher.rowMain}>
                        <span className={launcher.rowTitle}>{name}</span>
                      </span>
                    </span>
                    <Pencil size={12} />
                  </div>
                )}
              </div>
              <div className={launcher.create} data-demo-target={phase === 0 || undefined}>
                <Plus size={13} />
                {t('console.newTaskTemplate')}
              </div>
            </div>
          </div>
        </div>
      ) : showingRun ? (
        <div className={s.templateRunFrame} data-guide-run={phase === 3 ? 'initial' : 'repeat'}>
          <p className={s.templateHint}>
            {t(`guides.workflows.templates.${phase === 3 ? 'firstRunHint' : 'reuseRunHint'}`)}
          </p>
          <div className={`${thread.thread} ${s.templateRun}`}>
            <header className={thread.header}>
              <span className={thread.headerTitle}>{name}</span>
              <StatusBadge status="running" />
            </header>
            <div className={s.templateTranscript}>
              <div className={thread.cell}>
                <div className={thread.userRow}>
                  <div className={thread.bubble}>{t('guides.workflows.templates.value2')}</div>
                </div>
              </div>
              <div className={transcript.activityRow}>
                <span className={transcript.activityIcon}><OrbIndicator size={14} variant="expanding" /></span>
                <span className={activeText.text}>{t('sessionWorkbenchUi.agentActivity.working')}</span>
                <span className={transcript.activitySeparator}>·</span>
                <span className={transcript.activityElapsed}>
                  {t('sessionWorkbenchUi.agentActivity.durationSeconds', { seconds: Math.floor(time / 1000) })}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className={s.templateSheet}>
          <header className={task.head}>
            <div className={task.headText}>
              <h2 className={task.title}>{t('console.newTaskTemplate')}</h2>
              <p className={task.subtitle}>{t('console.templateReuseHint')}</p>
            </div>
            <X size={15} />
          </header>
          <div className={task.grid}>
            <div className={task.brief}>
              <span className={task.briefTag}>{t('console.briefEyebrow')}</span>
              <div className={task.name}>
                {phase === 1 ? typedText(name, interval(time, 300, 1500)) : name}
              </div>
              <div className={task.doc}>
                {phase === 1
                  ? typedText(t('guides.workflows.templates.value2'), interval(time, 1500, 3500))
                  : t('guides.workflows.templates.value2')}
              </div>
            </div>
            <div className={task.rail}>
              <div className={task.railTag}>{t('console.loadoutEyebrow')}</div>
              {(
                [
                  ['console.modeId', t('console.modeRunNow')],
                  ['console.approvalMode', t('console.approvalConfirmShort')],
                  ['console.imIntake', t('console.switchOff')],
                  ['console.browserEnvBinding', t('console.envTempBrowser')],
                  ['console.mcpConnections', t('console.mcpAllSummary')],
                  ['console.workspace', 'piskie-docs'],
                  ['console.browserBackground', t('console.switchOn')],
                ] as const
              ).map(([key, value]) => (
                <div
                  className={task.tile}
                  data-lit={key === 'console.workspace' || undefined}
                  key={key}
                >
                  <div className={task.tileHead}>
                    <span className={task.tileKey}>
                      {t(key)}
                      <ChevronRight size={9} />
                    </span>
                    <span className={task.tileValue}>{value}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <footer className={task.foot}>
            <span className={task.footHint} />
            <span className={task.cancel}>{t('common.cancel')}</span>
            <span className={task.submit} data-demo-target={phase === 2 || undefined}>
              <Play size={12} />
              {t('console.createAndRun')}
            </span>
          </footer>
        </div>
      )}
    </div>
  );
}
