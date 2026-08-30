import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Search, ShieldAlert, X } from 'lucide-react';

import type {
  MarketEntry,
  MarketInstalledItem,
  MarketInstallRequest,
  MarketProjectOption,
} from '@shared/types/market';
import { projectDisplayName } from '@shared/types/project';

import styles from './market.module.css';
import { capabilityLabels, compatibilityLabel } from './plugin-compatibility';

interface InstallScopeDialogProps {
  entry: MarketEntry | null;
  /** 更新已有安装时传入：锁定原安装位置，不允许改动。 */
  initialTarget?: MarketInstalledItem | null;
  projects: MarketProjectOption[];
  installing: boolean;
  onClose: () => void;
  onConfirm: (request: MarketInstallRequest) => void;
}

const InstallScopeDialog: React.FC<InstallScopeDialogProps> = ({
  entry,
  initialTarget,
  projects,
  installing,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<'user' | 'project'>(
    initialTarget?.scope === 'project' ? 'project' : 'user',
  );
  const [workspaces, setWorkspaces] = useState<string[]>(
    initialTarget?.scope === 'project' && initialTarget.workspace ? [initialTarget.workspace] : [],
  );
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [projectKeyword, setProjectKeyword] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.setAttribute('closedby', 'any');
    if (entry && !dialog.open) dialog.showModal();
    if (!entry && dialog.open) dialog.close();
  }, [entry, initialTarget]);

  const isUpdate = Boolean(initialTarget) || Boolean(entry?.updateAvailable);
  const scopeLocked = Boolean(initialTarget);
  const availableProjects = projects.filter((project) => project.available !== false);
  // 可执行内容按项目复制会产生多份可执行副本，只允许装到全局
  const projectChoiceBlocked = scopeLocked
    ? initialTarget?.scope !== 'project'
    : Boolean(entry?.executable) || availableProjects.length === 0;
  const projectChoiceHint = scopeLocked
    ? t('marketUi.install.updateKeepsLocation')
    : entry?.executable
      ? t('marketUi.install.executableGlobalOnly')
      : availableProjects.length === 0
        ? t('marketUi.install.noAvailableProjects')
        : t('marketUi.install.selectedProjectsOnly');

  const lockedWorkspace = scopeLocked && initialTarget?.scope === 'project' ? initialTarget.workspace : undefined;
  const displayedProjects = lockedWorkspace
    ? [projects.find((project) => project.workspace === lockedWorkspace) ?? {
        workspace: lockedWorkspace,
        name: lockedWorkspace.split(/[\\/]/).filter(Boolean).at(-1) ?? lockedWorkspace,
        runNames: [],
        lastActiveAt: '',
        threadCount: 0,
        available: false,
      }]
    : projects;
  // 搜索时已勾选的必须留着，否则勾了再搜就取消不掉
  const visibleProjects = projectKeyword.trim()
    ? displayedProjects.filter((project) => (
      workspaces.includes(project.workspace)
      || `${projectDisplayName(project)} ${project.workspace}`
        .toLowerCase()
        .includes(projectKeyword.trim().toLowerCase())
    ))
    : displayedProjects;

  const selectedProjectsAvailable = workspaces.length > 0 && workspaces.every((selectedWorkspace) => (
    displayedProjects.some((project) => (
      project.workspace === selectedWorkspace && project.available !== false
    ))
  ));

  const canConfirm = Boolean(entry)
    && entry?.installable !== false
    && (scope === 'user' || selectedProjectsAvailable)
    && (!entry?.executable || riskAccepted)
    && !installing;

  const confirmLabel = installing
    ? t('marketUi.install.installing')
    : isUpdate
      ? t('marketUi.install.confirmUpdate')
      : scope === 'user'
        ? t('marketUi.install.installGlobally')
        : workspaces.length > 0
          ? t('marketUi.install.installToProjects', { count: workspaces.length })
          : t('marketUi.install.chooseProjectsFirst');

  const serverCommands = useMemo(() => {
    if (!entry) return [];
    if (entry.kind === 'mcp' && entry.mcpConfig) {
      return [entry.mcpConfig.url ?? [entry.mcpConfig.command, ...(entry.mcpConfig.args ?? [])].filter(Boolean).join(' ')];
    }
    return entry.members?.mcpServers.map((server) =>
      server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' '),
    ) ?? [];
  }, [entry]);

  /** 远程包在安装前拿不到成员清单，那就一行都不列，不留空标题 */
  const installList = useMemo((): Array<{ label: string; value: string; mono?: boolean }> => {
    if (!entry) return [];
    if (entry.kind === 'skill') {
      return [{ label: t('marketUi.install.skillLabel'), value: entry.name }];
    }
    if (entry.kind === 'mcp') {
      return serverCommands.map((command) => ({
        label: t('marketUi.install.mcpServerLabel'),
        value: command,
        mono: true,
      }));
    }
    const rows: Array<{ label: string; value: string; mono?: boolean }> = [];
    if (entry.members?.skills.length) {
      rows.push({
        label: t('marketUi.install.skillLabel'),
        value: entry.members.skills
          .map((skill) => skill.name)
          .join(t('marketUi.install.memberSeparator')),
      });
    }
    if (entry.members?.mcpServers.length) {
      rows.push({
        label: t('marketUi.install.mcpServerLabel'),
        value: entry.members.mcpServers
          .map((server) => server.name)
          .join(t('marketUi.install.memberSeparator')),
      });
    }
    return rows;
  }, [entry, serverCommands, t]);

  /** 只有「装不了」「只装一部分」值得说；兼容和待定都不必占一行 */
  const compatibilityNote = useMemo(() => {
    const compatibility = entry?.compatibility;
    if (!compatibility) return null;
    const label = compatibilityLabel(compatibility, t);
    if (!label || compatibility.status === 'compatible') return null;
    return {
      label,
      detail: compatibility.reason ?? t('marketUi.install.onlySupportedMembers', {
        members: capabilityLabels(compatibility.supported, t),
      }),
    };
  }, [entry, t]);

  const closeAndReset = () => {
    setScope('user');
    setWorkspaces([]);
    setRiskAccepted(false);
    setProjectKeyword('');
    onClose();
  };

  const toggleWorkspace = (workspace: string, checked: boolean) => {
    setWorkspaces((current) => checked
      ? [...current, workspace]
      : current.filter((item) => item !== workspace));
  };

  return (
    <dialog ref={dialogRef} className={styles.dialog} onClose={closeAndReset}>
      {entry && (
        <div className={styles.dialogSheet}>
          <header className={styles.dialogHeader}>
            <div>
              <h2>
                {isUpdate
                  ? t('marketUi.install.updateNamed', { name: entry.name })
                  : t('marketUi.install.installNamed', { name: entry.name })}
              </h2>
              <p>
                {t('marketUi.install.fromSource', { source: entry.sourceName })}
                {entry.version ? ` · v${entry.version}` : ''}
              </p>
            </div>
            <button
              type="button"
              className={styles.dialogClose}
              onClick={closeAndReset}
              aria-label={t('marketUi.install.closeDialog')}
            >
              <X />
            </button>
          </header>

          {entry.description && <p className={styles.dialogDescription}>{entry.description}</p>}

          {compatibilityNote && (
            <p className={styles.dialogCompatibility}>
              <strong>{compatibilityNote.label}</strong>
              <span>{compatibilityNote.detail}</span>
            </p>
          )}

          {installList.length > 0 && (
            <div className={styles.installList}>
              <span className={styles.installListTitle}>{t('marketUi.install.contentsTitle')}</span>
              <ul>
                {installList.map((row) => (
                  <li key={`${row.label}-${row.value}`}>
                    <span>{row.label}</span>
                    {row.mono ? <code>{row.value}</code> : row.value}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!isUpdate && (
            <div className={styles.trustNote}>
              <ShieldAlert aria-hidden />
              <span>{t('marketUi.install.unreviewedSourceNotice')}</span>
            </div>
          )}

          <div className={styles.scopeList} role="radiogroup" aria-label={t('marketUi.install.locationAria')}>
            <span className={styles.scopeListTitle}>
              {isUpdate
                ? t('marketUi.install.lockedLocationTitle')
                : t('marketUi.install.locationTitle')}
            </span>

            <label
              className={`${styles.scopeRow} ${scope === 'user' ? styles.scopeRowSelected : ''} ${scopeLocked && initialTarget?.scope !== 'user' ? styles.scopeRowDisabled : ''}`}
            >
              <input
                type="radio"
                name="install-scope"
                value="user"
                checked={scope === 'user'}
                disabled={scopeLocked && initialTarget?.scope !== 'user'}
                onChange={() => {
                  if (!scopeLocked) setScope('user');
                }}
              />
              <span className={styles.scopeIndicator} aria-hidden />
              <span className={styles.scopeCopy}>
                <strong>{t('marketUi.location.global')}</strong>
                <span>{t('marketUi.install.globalDescription')}</span>
              </span>
            </label>

            <label
              className={`${styles.scopeRow} ${scope === 'project' ? styles.scopeRowSelected : ''} ${projectChoiceBlocked ? styles.scopeRowDisabled : ''}`}
            >
              <input
                type="radio"
                name="install-scope"
                value="project"
                checked={scope === 'project'}
                disabled={projectChoiceBlocked}
                onChange={() => {
                  if (!scopeLocked && !projectChoiceBlocked) setScope('project');
                }}
              />
              <span className={styles.scopeIndicator} aria-hidden />
              <span className={styles.scopeCopy}>
                <strong>
                  {scopeLocked && initialTarget?.scope === 'project'
                    ? t('marketUi.install.specificProject')
                    : t('marketUi.install.specificProjects')}
                </strong>
                <span>{projectChoiceHint}</span>
              </span>
            </label>

            {scope === 'project' && !projectChoiceBlocked && (
              <div className={styles.projectList}>
                {displayedProjects.length > 6 && (
                  <div className={styles.projectSearch}>
                    <Search aria-hidden />
                    <input
                      value={projectKeyword}
                      onChange={(event) => setProjectKeyword(event.target.value)}
                      placeholder={t('marketUi.filters.searchProjects')}
                      spellCheck={false}
                    />
                  </div>
                )}
                {visibleProjects.map((project) => {
                  const checked = workspaces.includes(project.workspace);
                  return (
                    <label
                      className={`${styles.projectRow} ${checked ? styles.projectRowSelected : ''} ${project.available === false ? styles.scopeRowDisabled : ''}`}
                      key={project.workspace}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={scopeLocked || project.available === false}
                        onChange={(event) => {
                          if (!scopeLocked) toggleWorkspace(project.workspace, event.target.checked);
                        }}
                      />
                      <span className={styles.projectIndicator} aria-hidden>{checked && <Check />}</span>
                      <span className={styles.projectCopy}>
                        <strong>{projectDisplayName(project)}</strong>
                        <small>
                          {project.workspace}
                          {project.available === false
                            ? ` · ${t('marketUi.filters.directoryUnavailable')}`
                            : ''}
                        </small>
                      </span>
                    </label>
                  );
                })}
                {visibleProjects.length === 0 && (
                  <p className={styles.projectPopoverEmpty}>{t('marketUi.filters.noProjectMatches')}</p>
                )}
              </div>
            )}
          </div>

          {entry.executable && (
            <label className={`${styles.riskRow} ${riskAccepted ? styles.riskRowSelected : ''}`}>
              <input
                type="checkbox"
                checked={riskAccepted}
                onChange={(event) => setRiskAccepted(event.target.checked)}
              />
              <span className={styles.projectIndicator} aria-hidden>{riskAccepted && <Check />}</span>
              <span>{t('marketUi.install.executableConsent')}</span>
            </label>
          )}

          <footer className={styles.dialogFooter}>
            <div className={styles.footerActions}>
              <button type="button" className={styles.secondaryButton} onClick={closeAndReset}>
                {t('marketUi.install.cancelAction')}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={!canConfirm}
                onClick={() => onConfirm({
                  entryId: entry.id,
                  scope,
                  workspaces: scope === 'project' ? workspaces : undefined,
                  allowExecutable: entry.executable ? riskAccepted : undefined,
                  force: initialTarget ? true : entry.installed || undefined,
                })}
              >
                {confirmLabel}
              </button>
            </div>
          </footer>
        </div>
      )}
    </dialog>
  );
};

export default InstallScopeDialog;
