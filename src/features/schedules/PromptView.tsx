import { AlertTriangle, Bot, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TaskDefinitionSnapshot } from '@shared/electron-contracts/task-definitions';
import type { ScheduleView } from '@shared/types/schedules';
import { describeInlineLaunch, describeTemplate, formatRelativeDateTime } from './format';
import { templateOf, type LiveStates } from './schedule-presenter';
import styles from './schedules.module.css';

export interface PromptViewProps {
  readonly view: ScheduleView;
  readonly definitions: readonly TaskDefinitionSnapshot[];
  readonly live: LiveStates;
  readonly now: Date;
  readonly locale: string;
  readonly onOpenTemplates: () => void;
  readonly onOpenRun: (agentId: string) => void;
}

export function PromptView(props: PromptViewProps) {
  const { t } = useTranslation();
  const { view, now, locale } = props;
  const { schedule } = view;
  const sample = view.nextRunAt
    ? formatRelativeDateTime(new Date(view.nextRunAt), now, locale, t)
    : formatRelativeDateTime(now, now, locale, t);

  if (schedule.action.kind === 'inject') {
    const { agentId, prompt } = schedule.action;
    const alive = Boolean(props.live[agentId]);
    return (
      <div className={styles.content}>
        <div className={styles.templateCard} data-tone={alive ? undefined : 'warning'}>
          <div className={styles.templateAvatar}><Bot size={16} /></div>
          <div className={styles.templateText}>
            <strong>{t('schedulesUi.launch.injectTitle', { agentId })}</strong>
            <small>{alive ? t('schedulesUi.target.inject') : t('schedulesUi.history.runGone')}</small>
          </div>
          {alive && (
            <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => props.onOpenRun(agentId)}>
              <ExternalLink size={14} />
              {t('schedulesUi.launch.openSession')}
            </button>
          )}
        </div>
        <div className={styles.sectionTitle}>{t('schedulesUi.promptView.triggerLine')}</div>
        <div className={styles.prompt}>{t('schedulesUi.promptView.injectText', { name: schedule.name, time: sample })}</div>
        <div className={styles.sectionTitle}>{t('schedulesUi.promptView.injectPrompt')}</div>
        <div className={styles.prompt}>{prompt}</div>
      </div>
    );
  }

  if ('prompt' in schedule.action) {
    const { launch, prompt } = schedule.action;
    return (
      <div className={styles.content}>
        <div className={styles.templateCard}>
          <div className={styles.templateAvatar}><Bot size={16} /></div>
          <div className={styles.templateText}>
            <strong>{t('schedulesUi.launch.inlineTitle')}</strong>
            <small>{describeInlineLaunch(launch, t)}</small>
          </div>
        </div>
        <div className={styles.sectionTitle}>{t('schedulesUi.promptView.triggerLine')}</div>
        <div className={styles.prompt}>{t('schedulesUi.promptView.triggerText', { name: schedule.name, time: sample })}</div>
        <div className={styles.sectionTitle}>{t('schedulesUi.promptView.fromAgent')}</div>
        <div className={styles.prompt}>{prompt}</div>
      </div>
    );
  }

  const template = templateOf(view, props.definitions);
  return (
    <div className={styles.content}>
      {template ? (
        <div className={styles.templateCard}>
          <div className={styles.templateAvatar}><Bot size={16} /></div>
          <div className={styles.templateText}>
            <strong>{t('schedulesUi.target.template', { name: template.name })}</strong>
            <small>{describeTemplate(template, t)}</small>
          </div>
          <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={props.onOpenTemplates}>
            <ExternalLink size={14} />
            {t('schedulesUi.form.manageTemplates')}
          </button>
        </div>
      ) : (
        <div className={styles.templateCard} data-tone="warning">
          <div className={styles.templateAvatar}><AlertTriangle size={16} /></div>
          <div className={styles.templateText}>
            <strong>{t('schedulesUi.target.templateMissing')}</strong>
            <small>{t('schedulesUi.promptView.templateMissing')}</small>
          </div>
        </div>
      )}
      <div className={styles.sectionTitle}>{t('schedulesUi.promptView.triggerLine')}</div>
      <div className={styles.prompt}>{t('schedulesUi.promptView.triggerText', { name: schedule.name, time: sample })}</div>
      {template && (
        <>
          <div className={styles.sectionTitle}>{t('schedulesUi.promptView.fromTemplate')}</div>
          <div className={styles.prompt}>{template.promptTemplate}</div>
        </>
      )}
    </div>
  );
}
