/**
 * TaskDefinitionLauncher —— 任务模板启动器。
 *
 * 原生 popover（`chrome/Popover` 负责 light-dismiss 与 Esc），开合不用手工管。
 * 三个入口共用同一个组件：左栏 `+`、左栏搜索的 Enter、空态卡片。
 *
 * **「启动任务模板」= 新建一次运行**，与「打开历史会话」= 恢复已有会话
 * 是两个不同动作，必须在视觉上区分。这里的行一律带「启动」语义的图标与措辞。
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Play, Plus, Trash2 } from 'lucide-react';

import type { TaskDefinitionSnapshot } from '../../../../shared/electron-contracts/task-definitions';
import { Popover } from '../chrome/Popover';
import styles from './taskDefinitionLauncher.module.css';

export interface TaskDefinitionLauncherProps {
  readonly definitions: readonly TaskDefinitionSnapshot[];
  readonly onStart: (definition: TaskDefinitionSnapshot) => void;
  readonly onCreate: () => void;
  readonly onEdit?: (definition: TaskDefinitionSnapshot) => void;
  readonly onDelete?: (definitionId: string) => void;
  /** 触发器；不传用默认的 `+` 按钮 */
  readonly trigger?: React.ReactNode;
  /** 外部过滤词（左栏搜索联动） */
  readonly filter?: string;
}

export const TaskDefinitionLauncher = memo<TaskDefinitionLauncherProps>(
  ({ definitions, onStart, onCreate, onEdit, onDelete, trigger, filter }) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);

    const visible = useMemo(() => {
      const needle = filter?.trim().toLowerCase();
      if (!needle) return definitions;
      return definitions.filter(
        (definition) =>
          definition.name.toLowerCase().includes(needle) ||
          definition.description?.toLowerCase().includes(needle) ||
          definition.category?.toLowerCase().includes(needle),
      );
    }, [definitions, filter]);

    const start = useCallback(
      (definition: TaskDefinitionSnapshot) => {
        setOpen(false);
        onStart(definition);
      },
      [onStart],
    );

    return (
      <Popover
        open={open}
        onClose={close}
        placement="block-end"
        trigger={
          <span onClick={() => setOpen((value) => !value)}>
            {trigger ?? (
              <button type="button" className={styles.trigger} aria-label={t('sessionWorkbenchUi.launcher.open')}>
                <Plus size={13} />
              </button>
            )}
          </span>
        }
      >
        <div className={styles.panel}>
          <div className={styles.head}>
            <span className={styles.title}>{t('sessionWorkbenchUi.launcher.heading')}</span>
            <span className={styles.count}>{t('sessionWorkbenchUi.launcher.templateCount', { count: visible.length })}</span>
          </div>

          <div className={styles.list}>
            {visible.length === 0 && <div className={styles.empty}>{t('sessionWorkbenchUi.launcher.noMatches')}</div>}

            {visible.map((definition) => (
              <div key={definition.definitionId} className={styles.row}>
                <button
                  type="button"
                  className={styles.rowStart}
                  aria-label={t('sessionWorkbenchUi.launcher.startTemplate', { name: definition.name })}
                  onClick={() => start(definition)}
                >
                  <span className={styles.rowIcon}>
                    <Play size={11} />
                  </span>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{definition.name}</span>
                    <span className={styles.rowMeta}>
                      {/* i18n-ignore -- legacy persisted task category value */}
                      {!definition.category || definition.category === 'custom' || definition.category === '自定义'
                        ? t('sessionWorkbenchUi.shell.customCategory')
                        : definition.category}
                    </span>
                  </span>
                </button>
                {(onEdit || onDelete) && (
                  <div className={styles.rowActions}>
                    {onEdit && (
                      <button
                        type="button"
                        className={`${styles.rowAction} ${styles.rowEdit}`}
                        aria-label={t('sessionWorkbenchUi.launcher.editTemplate', { name: definition.name })}
                        onClick={() => {
                          setOpen(false);
                          onEdit(definition);
                        }}
                      >
                        <Pencil size={11} />
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        className={`${styles.rowAction} ${styles.rowDelete}`}
                        aria-label={t('sessionWorkbenchUi.launcher.deleteTemplate', { name: definition.name })}
                        onClick={() => onDelete(definition.definitionId)}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <button
            type="button"
            className={styles.create}
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
          >
            <Plus size={12} />
            {t('sessionWorkbenchUi.launcher.createTemplate')}
          </button>
        </div>
      </Popover>
    );
  },
);

TaskDefinitionLauncher.displayName = 'TaskDefinitionLauncher';
