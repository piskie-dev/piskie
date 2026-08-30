/**
 * TaskDefinitionModal —— 创建自定义任务的「简报 + 装备栏」弹层。
 *
 * 左栏是一页任务简报：大字号名称 + 文档式描述——写简报，不是填表；
 * IM 模式下左栏切换为系统提示词（IM 消息本身就是任务输入）。
 * 右栏是装备栏（`LoadoutRail`）：能力牌亮起 = 偏离默认。
 *
 * 装配关系：
 * - 草稿是一个 reducer（`task-draft.ts`）——控件只发 patch，IM↔审批联动、
 *   校验、后端入参构造全在纯函数里；
 * - 原生 `<dialog>` 接线在 `useNativeDialog`（top layer / 焦点陷阱 /
 *   closedby=any / 浮层登记）；
 * - MCP 生效项清单在 `useEffectiveMcp`，随所选工作空间刷新。
 *
 * 全程无 AntD；校验/提交错误就地展示在底栏（antd message 挂在 body 上，
 * 会被 top layer 盖住）。
 */

import React, { useCallback, useEffect, useId, useReducer, useState } from 'react';
import { Play, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TaskDefinitionSnapshot } from '../../../shared/electron-contracts/task-definitions';
import {
  messageText,
  presentationFromError,
  resolvePresentationText,
  type PresentationText,
} from '../../i18n/presentationText';
import { useRendererRuntime } from '../../renderer-runtime/hooks';
import { LoadoutRail } from './LoadoutRail';
import {
  blankDraft,
  draftDefect,
  draftFromTaskDefinition,
  draftReducer,
  draftToTaskDefinitionInput,
  draftToTaskDefinitionUpdateInput,
  type TaskDraft,
} from './task-draft';
import { useEffectiveMcp } from './useEffectiveMcp';
import { useNativeDialog } from './useNativeDialog';
import styles from './taskDefinitionModal.module.css';

export interface TaskDefinitionModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 创建完成回调。shouldStart=true 表示调用方应启动 Agent（IM 模式仅创建） */
  readonly onCreated: (definition: TaskDefinitionSnapshot, shouldStart: boolean) => void;
  /** 默认开启 IM 模式（从 ConnectionEditorModal 打开时） */
  readonly defaultIMMode?: boolean;
  /** 传入时进入编辑模式，并用现有模板回填草稿。 */
  readonly editingDefinition?: TaskDefinitionSnapshot;
  readonly onUpdated?: (definition: TaskDefinitionSnapshot, shouldStart: boolean) => void;
  /** 从任务启动器进入编辑时，显示独立的“保存并启动”动作。 */
  readonly allowUpdateAndStart?: boolean;
}

export const TaskDefinitionModal: React.FC<TaskDefinitionModalProps> = ({
  open,
  onClose,
  onCreated,
  defaultIMMode = false,
  editingDefinition,
  onUpdated,
  allowUpdateAndStart = false,
}) => {
  const { t } = useTranslation();
  const dialogRef = useNativeDialog(open, onClose);
  const nameId = useId();
  const docId = useId();
  const editing = editingDefinition !== undefined;

  const [draft, dispatch] = useReducer(draftReducer, defaultIMMode, blankDraft);
  const patch = useCallback(
    (next: Partial<TaskDraft>) => dispatch({ kind: 'patch', patch: next }),
    [],
  );

  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<PresentationText | null>(null);
  const faultText = fault
    ? resolvePresentationText(fault, (key, values) => t(key, values))
    : null;

  // 打开即按当前入口重置草稿，创建与编辑不会沿用彼此的临时输入。
  useEffect(() => {
    if (!open) return;
    dispatch({
      kind: 'reset',
      draft: editingDefinition
        ? draftFromTaskDefinition(editingDefinition)
        : blankDraft(defaultIMMode),
    });
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- 弹层重开时的一次性归零 */
    setFault(null);
  }, [open, defaultIMMode, editingDefinition]);

  // MCP 生效项（跟随所选工作空间）
  const mcpCatalog = useEffectiveMcp(open, draft.workspace);

  const { taskDefinitions } = useRendererRuntime();

  const submit = useCallback(async (shouldStart: boolean) => {
    if (busy) return;
    const defect = draftDefect(draft);
    if (defect) {
      setFault(
        defect === 'name'
          ? messageText('console.taskNameRequired')
          : messageText('console.taskBriefRequired'),
      );
      return;
    }
    setFault(null);
    setBusy(true);
    try {
      const definition = editingDefinition
        ? await taskDefinitions.update(
            editingDefinition.definitionId,
            draftToTaskDefinitionUpdateInput(draft, editingDefinition),
          )
        : await taskDefinitions.create(draftToTaskDefinitionInput(draft));
      if (editingDefinition) onUpdated?.(definition, shouldStart);
      else onCreated(definition, !draft.im);
    } catch (error) {
      setFault(presentationFromError(
        error,
        messageText(editing ? 'console.updateTaskFailed' : 'console.taskTemplateCreateFailed'),
      ));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    draft,
    editing,
    editingDefinition,
    onCreated,
    onUpdated,
    taskDefinitions,
  ]);

  const title = editing ? t('console.editTaskTemplate') : t('console.newTaskTemplate');

  return (
    <dialog ref={dialogRef} className={styles.shell} aria-label={title}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(editing ? false : !draft.im);
        }}
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.subtitle}>
              {editing ? t('console.editTaskHint') : t('console.templateReuseHint')}
            </p>
          </div>
          <button type="button" className={styles.close} aria-label={t('common.cancel')} onClick={onClose}>
            <X size={15} />
          </button>
        </header>

        <div className={styles.grid}>
          {/* ── 左栏：任务简报（IM 模式下是系统提示词） ── */}
          <div className={styles.brief}>
            <label className={styles.briefTag} htmlFor={nameId}>
              {draft.im ? t('console.imBriefEyebrow') : t('console.briefEyebrow')}
            </label>
            <input
              id={nameId}
              type="text"
              className={styles.name}
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder={t('console.taskNameExample')}
            />
            <div className={styles.rule} />
            {draft.im ? (
              <>
                <textarea
                  id={docId}
                  className={styles.doc}
                  value={draft.charter}
                  onChange={(event) => patch({ charter: event.target.value })}
                  placeholder={t('console.systemPromptInstructionHint')}
                  aria-label={t('console.systemPrompt')}
                />
                <p className={styles.docHint}>{t('console.systemPromptBoundaryHint')}</p>
              </>
            ) : (
              <textarea
                id={docId}
                className={styles.doc}
                value={draft.brief}
                onChange={(event) => patch({ brief: event.target.value })}
                placeholder={t('console.briefPlaceholder')}
                aria-label={t('console.taskBrief')}
              />
            )}
          </div>

          {/* ── 右栏：装备栏。随弹层重开重挂载，展开态/环境拉取一并归零 ── */}
          {open && <LoadoutRail draft={draft} patch={patch} mcp={mcpCatalog} />}
        </div>

        <footer className={styles.foot}>
          {faultText ? (
            <span className={styles.formError} role="alert">{faultText}</span>
          ) : (
            <span className={styles.footHint}>{t('console.loadoutHint')}</span>
          )}
          <button type="button" className={styles.cancel} disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          {editing && allowUpdateAndStart && (
            <button
              type="button"
              className={styles.saveAndStart}
              disabled={busy}
              onClick={() => void submit(true)}
            >
              <Play size={11} />
              {busy ? t('console.saving') : t('console.saveAndStart')}
            </button>
          )}
          <button type="submit" className={styles.submit} disabled={busy}>
            {editing
              ? busy ? t('console.saving') : t('common.save')
              : busy
                ? t('console.creating')
                : draft.im
                  ? t('console.createWithoutRun')
                  : t('console.createAndRun')}
          </button>
        </footer>
      </form>
    </dialog>
  );
};
