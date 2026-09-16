import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, FolderOpen, GitBranch, Loader2 } from 'lucide-react';
import { resolvePresentationText } from '../../../../i18n/presentationText';
import { Popover } from '../../chrome/Popover';
import { useWorkspaceInfo } from './useWorkspaceInfo';
import { BranchMenu } from './BranchMenu';
import styles from './workspaceBar.module.css';

interface WorkspaceBarProps {
  readonly workspace?: string | null;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly editActions?: {
    readonly chooseFolder: () => void;
    readonly useDefault: () => void;
  };
}

export function WorkspaceBar(props: WorkspaceBarProps) {
  // Switching conversations/directories discards menus and pending reads for the previous path.
  return <WorkspaceBarContent key={JSON.stringify(props.workspace) ?? 'default'} {...props} />;
}

function WorkspaceBarContent({ workspace, className, disabled, editActions }: WorkspaceBarProps) {
  const { t } = useTranslation();
  const { info, error, switchError, createError, loading, switching, creating, refresh, switchBranch, createBranch, clearBranchErrors } = useWorkspaceInfo(workspace);
  const [folderOpen, setFolderOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const fullPath = info?.path ?? workspace;
  const directory = fullPath?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || fullPath;
  const directoryLabel = editActions && workspace === undefined
    ? t('sessionWorkbenchUi.shell.defaultWorkspace')
    : directory || t(loading
      ? 'sessionWorkbenchUi.composer.workspaceLoading'
      : 'sessionWorkbenchUi.composer.workspaceUnavailable');
  const directoryAria = fullPath
    ? t('sessionWorkbenchUi.composer.workspacePath', { path: fullPath })
    : directoryLabel;
  const git = info?.git;
  const head = git?.head;
  const branchLabel = head?.kind === 'detached'
    ? t('sessionWorkbenchUi.composer.detachedHead', { commit: head.commit.slice(0, 7) })
    : head?.kind === 'unborn'
      ? t('sessionWorkbenchUi.composer.unbornBranch', { branch: head.name })
      : head?.name;
  const busy = !!disabled || switching || creating;
  const directoryContent = <><FolderOpen size={13} aria-hidden /><span className={styles.label}>{directoryLabel}</span></>;

  return (
    <div className={className} data-composer-control="true">
      <div className={styles.bar}>
        {editActions ? (
          <Popover open={folderOpen} onClose={() => setFolderOpen(false)} placement="block-start" triggerClassName={styles.directorySlot}
            trigger={(
              <button type="button" className={styles.control} title={fullPath ?? undefined} aria-label={directoryAria}
                aria-haspopup="menu" aria-expanded={folderOpen} disabled={busy} onClick={() => setFolderOpen((value) => !value)}>
                {directoryContent}<ChevronDown size={11} aria-hidden />
              </button>
            )}>
            {folderOpen && (
              <div className={styles.menu} role="menu">
                <button type="button" role="menuitem" className={styles.option} disabled={busy} onClick={() => {
                  setFolderOpen(false); editActions.chooseFolder();
                }}>{t('sessionWorkbenchUi.composer.chooseFolder')}</button>
                <button type="button" role="menuitem" className={styles.option} disabled={busy} onClick={() => {
                  setFolderOpen(false); editActions.useDefault();
                }}>{t('sessionWorkbenchUi.composer.useDefaultWorkspace')}</button>
              </div>
            )}
          </Popover>
        ) : (
          <span className={`${styles.control} ${styles.directorySlot}`} title={fullPath ?? undefined} aria-label={directoryAria}>
            {directoryContent}
          </span>
        )}
        {git && (
          <>
            <span className={styles.separator} aria-hidden />
            <Popover open={branchOpen} onClose={() => setBranchOpen(false)} placement="block-start" align="start" triggerClassName={styles.branchSlot}
              trigger={(
                <button type="button" className={styles.control} title={branchLabel}
                  aria-label={t('sessionWorkbenchUi.composer.switchBranch', { branch: branchLabel })}
                  aria-haspopup="dialog" aria-expanded={branchOpen} disabled={busy}
                  onClick={() => {
                    if (!branchOpen) { clearBranchErrors(); refresh(); }
                    setBranchOpen((value) => !value);
                  }}>
                  {switching || creating ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <GitBranch size={13} aria-hidden />}
                  <span className={styles.label}>{branchLabel}</span><ChevronDown size={11} aria-hidden />
                </button>
              )}>
              {branchOpen && (
                <BranchMenu git={git} loading={loading} busy={busy} creating={creating}
                  switchError={switchError} createError={createError} clearErrors={clearBranchErrors}
                  switchBranch={switchBranch} createBranch={createBranch} onSwitched={() => setBranchOpen(false)} />
              )}
            </Popover>
          </>
        )}
      </div>
      {error && <div className={styles.error} role="alert">
        <span>{resolvePresentationText(error, t)}</span>
        <button type="button" className={styles.retry} disabled={loading || busy} onClick={() => void refresh()}>
          {t('sessionWorkbenchUi.composer.retryWorkspace')}
        </button>
      </div>}
      {(switchError || createError) && (!branchOpen || !git) && <div className={styles.error} role="alert">{resolvePresentationText((switchError || createError)!, t)}</div>}
    </div>
  );
}
