/**
 * Shared execution task list for conversation and canvas modes.
 *
 * The component owns only presentation state. Task grouping and plan loading
 * stay in their existing data-layer owners.
 */

import React, { memo, useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Globe, Image as ImageIcon, ListChecks, Terminal, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LinkedMarkdown } from '@/components/content-links';
import type { TaskItem, TaskItemStatus } from '../../../../shared/types';
import { Dialog } from '../chrome/Dialog';
import { hasActivity, type ActivityChips } from '../data/activity';
import { groupTaskBoardItems, taskProgress, type WorkerLabel } from '../data/taskGroups';
import { usePlanDocument } from '../data/usePlanDocument';
import activeTextStyles from './activeText.module.css';
import styles from './TaskList.module.css';

const STATUS_KEY: Record<TaskItemStatus, string> = {
  pending: 'sessionWorkbenchUi.taskList.pending',
  in_progress: 'sessionWorkbenchUi.taskList.running',
  completed: 'sessionWorkbenchUi.taskList.completed',
};

const HeaderCheck = () => (
  <svg className={styles.headerCheck} viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2.25a9.75 9.75 0 1 0 0 19.5 9.75 9.75 0 0 0 0-19.5Zm3.61 7.936a.75.75 0 0 0-1.22-.872l-3.236 4.53-1.624-1.624a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
    />
  </svg>
);

const ProgressGlyph = ({ percent }: { readonly percent: number }) => (
  <span
    className={styles.progressGlyph}
    style={{ '--task-progress': `${percent}%` } as React.CSSProperties}
    aria-hidden="true"
  >
    <svg className={styles.progressRing} viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeDasharray="2.2 4.4"
        strokeLinecap="round"
      />
    </svg>
  </span>
);

const StatusMark = memo<{ readonly status: TaskItemStatus }>(({ status }) => (
  <span className={styles.statusMark} data-status={status} aria-hidden="true">
    {status === 'pending' && (
      <svg viewBox="0 0 24 24">
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeDasharray="1.8 3.6"
          strokeLinecap="round"
        />
      </svg>
    )}
    {status === 'in_progress' && (
      <svg viewBox="0 0 24 24">
        <path
          d="m12.75 15 3-3m0 0-3-3m3 3h-7.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )}
    {status === 'completed' && (
      <svg viewBox="0 0 24 24">
        <path
          d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )}
  </span>
));

StatusMark.displayName = 'TaskListStatusMark';

const Chips = memo<{ readonly chips: ActivityChips; readonly compact?: boolean }>(({ chips, compact }) => (
  <span className={styles.chips}>
    {(chips.added > 0 || chips.removed > 0) && (
      <span className={styles.chip}>
        {chips.added > 0 && <span className={styles.diffAdd}>+{chips.added}</span>}
        {chips.removed > 0 && <span className={styles.diffRemove}>-{chips.removed}</span>}
      </span>
    )}
    {chips.images > 0 && (
      <span className={styles.chip}>
        <ImageIcon size={10} />
        {chips.images}
      </span>
    )}
    {!compact && chips.browserSteps > 0 && (
      <span className={styles.chip}>
        <Globe size={10} />
        {chips.browserSteps}
      </span>
    )}
    {!compact && chips.commands > 0 && (
      <span className={styles.chip}>
        <Terminal size={10} />
        {chips.commands}
      </span>
    )}
    {!compact && chips.skillCalls > 0 && (
      <span className={styles.chip}>
        <Wand2 size={10} />
        {chips.skillCalls}
      </span>
    )}
  </span>
));

Chips.displayName = 'TaskListChips';

const TaskRow = memo<{
  readonly item: TaskItem;
  readonly index: number;
  readonly chips?: ActivityChips;
}>(({ item, index, chips }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  return (
    <li
      className={styles.item}
      data-status={item.status}
      style={{ '--task-index': index } as React.CSSProperties}
    >
      <button type="button" className={styles.itemHead} onClick={toggle} aria-expanded={open}>
        <StatusMark status={item.status} />
        <span className="sr-only">{t(STATUS_KEY[item.status])}: </span>
        <span
          className={
            item.status === 'in_progress'
              ? `${styles.itemSubject} ${activeTextStyles.text}`
              : styles.itemSubject
          }
        >
          {item.subject}
        </span>
        {chips && hasActivity(chips) && <Chips chips={chips} />}
        <span className={styles.itemCaret}>
          <ChevronRight size={11} />
        </span>
      </button>

      {open && (
        <div className={styles.itemDetail}>
          {item.description && <p className={styles.itemDescription}>{item.description}</p>}
          <div className={styles.itemMeta}>
            <span>{t('sessionWorkbenchUi.taskList.owner')}: {item.owner ?? t('sessionWorkbenchUi.taskList.unassignedOwner')}</span>
            <span>{t('sessionWorkbenchUi.taskList.dependsOn')}: {item.dependsOn.length > 0
              ? item.dependsOn.join(', ')
              : t('sessionWorkbenchUi.taskList.noDependencies')}</span>
          </div>
        </div>
      )}
    </li>
  );
});

TaskRow.displayName = 'TaskListRow';

export interface TaskListProps {
  readonly taskBoard: { readonly taskSummary: string; readonly items: readonly TaskItem[] };
  readonly scope: 'main' | 'worker';
  readonly mainAgentId?: string;
  readonly workers?: readonly WorkerLabel[];
  readonly historicalWorkerSubjects?: Readonly<Record<string, string>>;
  readonly agentId?: string;
  readonly chips?: ActivityChips;
  readonly taskChips?: ReadonlyMap<string, ActivityChips>;
}

export const TaskList = memo<TaskListProps>(
  ({
    taskBoard,
    scope,
    mainAgentId = '',
    workers = [],
    historicalWorkerSubjects,
    agentId,
    chips,
    taskChips,
  }) => {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const items = taskBoard.items;
    const { done, total } = taskProgress(items);
    const activeItem = items.find((item) => item.status === 'in_progress');
    const allDone = total > 0 && done === total;
    const started = done > 0 || Boolean(activeItem);
    const progressPercent = total > 0 ? Math.round((done / total) * 100) : 0;
    const plan = usePlanDocument(agentId);

    const groups =
      scope === 'worker'
        ? [{ key: 'current-assignment', label: t('sessionWorkbenchUi.taskList.currentWorkPackage'), items }]
        : groupTaskBoardItems(items, mainAgentId, workers, historicalWorkerSubjects ?? {}, {
            main: t('sessionWorkbenchUi.taskList.mainGroup'),
            unassigned: t('sessionWorkbenchUi.taskGroup.unassigned'),
            historicalWorker: t('sessionWorkbenchUi.taskGroup.historicalWorker'),
          });
    const showGroupLabels = groups.length > 1;

    const viewPlan = useCallback(() => plan.view(), [plan]);

    if (items.length === 0) return null;

    return (
      <>
        <section
          className={styles.taskList}
          data-expanded={expanded ? 'true' : undefined}
          data-state={allDone ? 'completed' : activeItem ? 'active' : 'pending'}
          aria-label={t('sessionWorkbenchUi.taskList.heading')}
        >
          <div className={styles.header}>
            <button
              type="button"
              className={styles.toggle}
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              <span className={styles.headerIcon}>
                <span className={styles.headerState}>
                  {allDone ? (
                    <HeaderCheck />
                  ) : started ? (
                    <ProgressGlyph percent={progressPercent} />
                  ) : (
                    <ListChecks size={14} />
                  )}
                </span>
                <ChevronDown className={styles.headerChevron} size={14} />
              </span>
              <span className={styles.headerTitle}>{t('sessionWorkbenchUi.taskList.heading')}</span>
              {chips && hasActivity(chips) && (
                <span className={styles.headerActivity}>
                  <Chips chips={chips} compact />
                </span>
              )}
              <span className={styles.headerCount}>{done}/{total}</span>
            </button>

            {scope === 'main' && (
              <button type="button" className={styles.planButton} onClick={viewPlan} aria-label={t('sessionWorkbenchUi.taskList.viewPlan')}>
                <FileText size={12} />
              </button>
            )}
          </div>

          <div
            className={styles.collapsible}
            data-collapsed={!expanded ? 'true' : undefined}
            aria-hidden={!expanded}
            {...(!expanded ? { inert: '' } : {})}
          >
            <div className={styles.collapsibleInner}>
              <div className={styles.scrollArea}>
                {taskBoard.taskSummary && <div className={styles.taskSummary}>{taskBoard.taskSummary}</div>}

                <div className={styles.groups}>
                  {groups.map((group) => (
                    <section key={group.key} className={styles.group}>
                      {showGroupLabels && (
                        <div className={styles.groupHead}>
                          <span
                            className={styles.groupLabel}
                            data-inactive={group.workerActive === false ? 'true' : undefined}
                          >
                            {group.label}
                          </span>
                          <span className={styles.groupRule} />
                        </div>
                      )}

                      <ul className={styles.items}>
                        {group.items.map((item, index) => (
                          <TaskRow key={item.id} item={item} index={index} chips={taskChips?.get(item.id)} />
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {scope === 'main' && (
          <Dialog
            open={plan.open}
            onClose={plan.close}
            title={plan.document?.taskSummary || t('sessionWorkbenchUi.taskList.planDocument')}
            width={640}
          >
            <div className={styles.planBody}>
              {plan.loading ? (
                <div className={styles.planEmpty}>{t('sessionWorkbenchUi.taskList.loading')}</div>
              ) : plan.document ? (
                <div className="markdown-dark-theme">
                  <LinkedMarkdown>{plan.document.content}</LinkedMarkdown>
                </div>
              ) : (
                <div className={styles.planEmpty}>{t('sessionWorkbenchUi.taskList.noApprovedPlan')}</div>
              )}
            </div>
          </Dialog>
        )}
      </>
    );
  },
);

TaskList.displayName = 'TaskList';
