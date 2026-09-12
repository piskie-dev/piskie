import { useLayoutEffect, useRef, useState } from 'react';
import { HelpCircle, RefreshCw, Search, Undo2, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  WorkerPreferencesDocument,
  WorkerTypeDescriptor,
} from '../../../shared/types/worker-preferences';
import { type ModelOptGroup } from '../../store/inferenceStore';
import { Dialog } from '../console/chrome/Dialog';
import {
  draftProblem,
  fromProfile,
  sameValue,
  type InferenceDraft,
  type WorkerDraft,
} from './worker-preference-drafts';
import { WorkerDisplayNameEditor } from './WorkerDisplayNameEditor';
import { WorkerInferenceSection } from './WorkerInferenceSection';
import { AgentTypeIcon } from './AgentTypeIcon';
import styles from './agent-management.module.css';

export interface AgentManagementViewProps {
  document: WorkerPreferencesDocument | null;
  types: WorkerTypeDescriptor[];
  groups: ModelOptGroup[];
  drafts: Record<string, WorkerDraft>;
  selected: string;
  scrollPositions: Readonly<Record<string, number>>;
  rememberScroll: (type: string, top: number) => void;
  loading: boolean;
  saving: string | null;
  loadError: string | null;
  modelError: string | null;
  saveErrors: Record<string, string>;
  savedType: string | null;
  select: (type: string) => void;
  edit: (type: string, value: InferenceDraft) => void;
  editDisplayName: (type: string, displayName: string) => void;
  discard: (type: string) => void;
  rebase: (type: string) => void;
  save: (type: string) => Promise<void>;
  onConfigureModels: () => void;
  onRefresh: () => void;
}

export function AgentManagementView(props: AgentManagementViewProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollTop = props.scrollPositions[props.selected] ?? 0;
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = scrollTop;
  }, [props.selected, scrollTop]);
  const [helpOpen, setHelpOpen] = useState(false);
  const { document, types, groups, drafts, selected, saving } = props;
  const removedTypes = Object.keys(document?.profiles ?? {}).filter(
    (type) => !types.some((entry) => entry.type === type)
  );
  const entries = [...types, ...removedTypes.map((type) => ({ type, description: '' }))];
  const remark = (type: string) =>
    (drafts[type]?.displayName ?? document?.profiles[type]?.displayName ?? '').trim();
  const typeName = (type: string) => remark(type) || type;
  const entry = entries.find((item) => item.type === selected);
  const removed = removedTypes.includes(selected);
  const savedProfile = document?.profiles[selected];
  const draft = drafts[selected];
  const value = draft?.value ?? fromProfile(savedProfile);
  const edit = (next: InferenceDraft) => props.edit(selected, next);
  const problem = draftProblem(value, groups);
  const savedProblem = savedProfile?.inference && draftProblem(fromProfile(savedProfile), groups);
  const inferenceChanged = !sameValue(value, fromProfile(savedProfile));
  const canSave = Boolean(
    draft &&
      !draft.conflict &&
      (!inferenceChanged || !problem) &&
      !saving &&
      !props.loadError &&
      (!inferenceChanged || value.mode !== 'fixed' || !props.modelError)
  );
  return (
    <div className={styles.workspace}>
      <aside className={styles.directory} aria-label={t('agentManagement.directory')}>
        <header className={styles.directoryHeader}>
          <h1>{t('agentManagement.title')}</h1>
          <span className={styles.count}>{types.length}</span>
          <div className={styles.directoryActions}>
            <button
              className={styles.iconButton}
              disabled={props.loading}
              onClick={props.onRefresh}
              aria-label={t('common.refresh')}
              title={t('common.refresh')}
            >
              <RefreshCw size={16} />
            </button>
            <button
              className={styles.iconButton}
              onClick={() => setHelpOpen(true)}
              aria-label={t('agentManagement.help')}
              title={t('agentManagement.help')}
            >
              <HelpCircle size={16} />
            </button>
          </div>
        </header>
        <label className={styles.search}>
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('agentManagement.search')}
            aria-label={t('agentManagement.search')}
          />
        </label>
        <nav className={styles.typeList}>
          {entries
            .filter((item) =>
              `${typeName(item.type)} ${item.type} ${item.description}`
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase())
            )
            .map((item) => {
              const pending = drafts[item.type];
              const missing = removedTypes.includes(item.type);
              const invalid =
                document?.profiles[item.type]?.inference &&
                draftProblem(fromProfile(document.profiles[item.type]), groups);
              return (
                <button
                  key={item.type}
                  className={styles.typeItem}
                  aria-current={item.type === selected ? 'page' : undefined}
                  onClick={() => {
                    props.select(item.type);
                  }}
                >
                  <span className={styles.typeAvatar}>
                    <AgentTypeIcon type={item.type} size={20} />
                  </span>
                  <span className={styles.typeText}>
                    <strong>{typeName(item.type)}</strong>
                    {remark(item.type) && <small className={styles.typeId}>{item.type}</small>}
                    <small>
                      {pending
                        ? t('agentManagement.unsaved')
                        : missing
                          ? t('agentManagement.removed')
                          : invalid
                            ? t('agentManagement.invalid')
                            : document?.profiles[item.type]?.inference
                              ? t('agentManagement.fixed')
                              : t('agentManagement.inherit')}
                    </small>
                  </span>
                  {pending ? (
                    <span className={styles.draftDot} aria-label={t('agentManagement.unsaved')} />
                  ) : missing || invalid ? (
                    <AlertTriangle size={13} />
                  ) : null}
                </button>
              );
            })}
          {!entries.length && (
            <p className={styles.empty}>
              {t(props.loading ? 'agentManagement.loading' : 'agentManagement.noTypes')}
            </p>
          )}
          {entries.length > 0 &&
            !entries.some((item) =>
              `${typeName(item.type)} ${item.type} ${item.description}`
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase())
            ) && <p className={styles.empty}>{t('agentManagement.noMatches')}</p>}
        </nav>
      </aside>
      <main className={styles.detail} aria-label={t('agentManagement.details')}>
        {props.loadError && (
          <div className={styles.error} role="alert">
            {t('agentManagement.loadFailed')}
            <p>{props.loadError}</p>
            <button className={styles.textButton} onClick={props.onRefresh}>
              {t('common.refresh')}
            </button>
          </div>
        )}
        {entry ? (
          <>
            <header className={styles.identity}>
              <span className={styles.avatar}>
                <AgentTypeIcon type={entry.type} size={24} />
              </span>
              <div>
                <div className={styles.identityTitle}>
                  <h2>{typeName(entry.type)}</h2>
                  {remark(entry.type) && <code>{entry.type}</code>}
                  {!removed && (
                    <WorkerDisplayNameEditor
                      key={entry.type}
                      type={entry.type}
                      value={draft?.displayName ?? savedProfile?.displayName ?? ''}
                      disabled={!!saving}
                      onChange={(displayName) => props.editDisplayName(entry.type, displayName)}
                    />
                  )}
                </div>
                <p>
                  {entry.description || (removed ? t('agentManagement.removedDescription') : '')}
                </p>
              </div>
            </header>
            <div
              className={styles.tabs}
              role="tablist"
              aria-label={t('agentManagement.categories')}
            >
              <button
                id="agent-inference-tab"
                role="tab"
                aria-selected="true"
                aria-controls="agent-inference-panel"
              >
                {t('agentManagement.inference')}
              </button>
            </div>
            <div
              ref={contentRef}
              onScroll={(event) => props.rememberScroll(selected, event.currentTarget.scrollTop)}
              className={styles.content}
              id="agent-inference-panel"
              role="tabpanel"
              aria-labelledby="agent-inference-tab"
            >
              {draft?.conflict && (
                <div className={styles.warning} role="alert">
                  <strong>{t('agentManagement.conflictTitle')}</strong>
                  <p>{t('agentManagement.conflictBody')}</p>
                  <div className={styles.actions}>
                    <button
                      className={styles.button}
                      disabled={!!saving}
                      onClick={() => props.discard(selected)}
                    >
                      {t('agentManagement.loadLatest')}
                    </button>
                    <button
                      className={styles.button}
                      disabled={!!saving}
                      onClick={() => props.rebase(selected)}
                    >
                      {t('agentManagement.keepDraft')}
                    </button>
                  </div>
                </div>
              )}
              {removed ? (
                <div className={styles.warning}>
                  <strong>{t('agentManagement.removed')}</strong>
                  <p>{t('agentManagement.removedDescription')}</p>
                  <button
                    className={styles.button}
                    disabled={!!saving}
                    onClick={() => edit({ mode: 'remove' })}
                  >
                    {t('agentManagement.clearRemoved')}
                  </button>
                </div>
              ) : (
                <>
                  <WorkerInferenceSection
                    key={selected}
                    value={value}
                    groups={groups}
                    saving={!!saving}
                    edit={edit}
                    modelError={props.modelError}
                    onConfigureModels={props.onConfigureModels}
                    onRefresh={props.onRefresh}
                  />
                </>
              )}
              {savedProblem && !removed && !props.modelError && (
                <div className={styles.warning} role="status">
                  <AlertTriangle size={16} />
                  <div>
                    <strong>{t('agentManagement.savedInvalid')}</strong>
                    <p>{t('agentManagement.savedInvalidDescription')}</p>
                  </div>
                </div>
              )}
              {props.saveErrors[selected] && (
                <div className={styles.error} role="alert">
                  <strong>{t('agentManagement.saveFailed')}</strong>
                  <p>{props.saveErrors[selected]}</p>
                </div>
              )}
            </div>
            <footer className={styles.footer}>
              <div className={styles.footerStatus} role="status">
                <span>
                  {t(
                    saving === selected
                      ? 'agentManagement.saving'
                      : props.savedType === selected
                        ? 'agentManagement.saved'
                        : draft
                          ? 'agentManagement.unsaved'
                          : 'agentManagement.upToDate'
                  )}
                </span>
                <small>
                  {t(
                    draft && !inferenceChanged
                      ? 'agentManagement.remarkOnly'
                      : 'agentManagement.newInstancesOnly'
                  )}
                </small>
              </div>
              <div className={styles.actions}>
                <button
                  className={styles.button}
                  disabled={!draft || !!saving}
                  onClick={() => props.discard(selected)}
                >
                  <Undo2 size={14} />
                  {t('agentManagement.discard')}
                </button>
                <button
                  className={`${styles.button} ${styles.primary}`}
                  disabled={!canSave}
                  onClick={() => void props.save(selected)}
                >
                  {t('common.save')}
                </button>
              </div>
            </footer>
          </>
        ) : (
          <div className={styles.empty}>
            {t(props.loading ? 'agentManagement.loading' : 'agentManagement.selectType')}
          </div>
        )}
      </main>
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title={t('agentManagement.help')}>
        <div className={styles.help}>
          <AgentManagementHelp />
          <button className={styles.button} onClick={() => setHelpOpen(false)}>
            {t('common.close')}
          </button>
        </div>
      </Dialog>
    </div>
  );
}

export function AgentManagementHelp({ scopeOnly = false }: { scopeOnly?: boolean }) {
  const { t } = useTranslation();
  return <>
    {!scopeOnly && <p>{t('agentManagement.helpTypes')}</p>}
    {!scopeOnly && <p>{t('agentManagement.inheritNote')}</p>}
    <p>{t('agentManagement.helpInstances')}</p>
    <p>{t('agentManagement.helpSave')}</p>
  </>;
}
