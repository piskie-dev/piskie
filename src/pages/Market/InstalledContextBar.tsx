import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Search } from 'lucide-react';

import type { MarketInstalledScope, MarketProjectOption } from '@shared/types/market';
import { projectDisplayName } from '@shared/types/project';

import styles from './market.module.css';

interface InstalledContextBarProps {
  scopes: MarketInstalledScope[];
  workspace?: string;
  projects: MarketProjectOption[];
  onScopesChange: (scopes: MarketInstalledScope[]) => void;
  onWorkspaceChange: (workspace?: string) => void;
}

/** 一行放得下这么几个项目，再多就收进「更多」弹层 */
const INLINE_PROJECT_SLOTS = 3;

/** 项目名已经是路径最后一段，小字只补上它的上级目录 */
const parentPath = (workspace: string) => {
  const segments = workspace.split(/[\\/]/);
  return segments.slice(0, -1).join('/') || workspace;
};

const projectMatches = (project: MarketProjectOption, keyword: string) => {
  const needle = keyword.trim().toLowerCase();
  return `${projectDisplayName(project)} ${project.workspace}`.toLowerCase().includes(needle);
};

interface ProjectRowProps {
  projects: MarketProjectOption[];
  workspace?: string;
  onWorkspaceChange: (workspace?: string) => void;
}

const ProjectRow: React.FC<ProjectRowProps> = ({ projects, workspace, onWorkspaceChange }) => {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    const node = popoverRef.current;
    if (!node) return undefined;
    node.setAttribute('popover', 'auto');
    const onToggle = (event: Event) => {
      const opened = (event as Event & { newState?: string }).newState === 'open';
      if (opened) searchRef.current?.focus();
      else setKeyword('');
    };
    node.addEventListener('toggle', onToggle);
    return () => node.removeEventListener('toggle', onToggle);
  }, []);

  const inline = useMemo(() => {
    if (projects.length <= INLINE_PROJECT_SLOTS + 1) return projects;
    const head = projects.slice(0, INLINE_PROJECT_SLOTS);
    if (!workspace || head.some((project) => project.workspace === workspace)) return head;
    // 选中的排得再靠后也要留在行里，否则看不出当前筛的是哪个项目
    const picked = projects.find((project) => project.workspace === workspace);
    return picked ? [...head.slice(0, INLINE_PROJECT_SLOTS - 1), picked] : head;
  }, [projects, workspace]);

  const rest = projects.filter((project) => !inline.includes(project));
  // 输入关键词后在全部项目里搜，免得搜不到已经摆在行里的那几个
  const listed = keyword.trim() ? projects.filter((project) => projectMatches(project, keyword)) : rest;

  const pick = (next?: string) => {
    onWorkspaceChange(next);
    popoverRef.current?.hidePopover();
  };

  return (
    <div className={styles.filterRow} role="group" aria-label={t('marketUi.filters.projectAria')}>
      <span className={styles.filterLabel}>{t('marketUi.filters.projectLabel')}</span>
      <button
        type="button"
        className={`${styles.filterChip} ${workspace ? '' : styles.filterChipActive}`}
        aria-pressed={!workspace}
        onClick={() => onWorkspaceChange(undefined)}
      >
        {t('marketUi.filters.allProjects')}
      </button>
      {inline.map((project) => {
        const active = project.workspace === workspace;
        return (
          <button
            type="button"
            key={project.workspace}
            className={`${styles.filterChip} ${styles.projectChip} ${active ? styles.filterChipActive : ''}`}
            aria-pressed={active}
            title={project.available === false
              ? t('marketUi.filters.unavailableProjectTitle', { path: project.workspace })
              : project.workspace}
            onClick={() => onWorkspaceChange(active ? undefined : project.workspace)}
          >
            {projectDisplayName(project)}
          </button>
        );
      })}
      {rest.length > 0 && (
        <>
          <button
            type="button"
            className={`${styles.filterChip} ${styles.moreProjects}`}
            onClick={() => popoverRef.current?.togglePopover()}
          >
            {t('marketUi.filters.moreProjects', { count: rest.length })}
            <ChevronDown aria-hidden />
          </button>
          <div ref={popoverRef} className={styles.projectPopover}>
            <div className={styles.projectSearch}>
              <Search aria-hidden />
              <input
                ref={searchRef}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder={t('marketUi.filters.searchProjects')}
                spellCheck={false}
              />
            </div>
            <div className={styles.projectPopoverList}>
              {listed.map((project) => {
                const active = project.workspace === workspace;
                return (
                  <button
                    type="button"
                    key={project.workspace}
                    className={`${styles.projectPopoverItem} ${active ? styles.projectPopoverItemActive : ''}`}
                    title={project.workspace}
                    onClick={() => pick(active ? undefined : project.workspace)}
                  >
                    <span className={styles.projectPopoverCheck} aria-hidden>{active && <Check />}</span>
                    <span className={styles.projectPopoverCopy}>
                      <strong>{projectDisplayName(project)}</strong>
                      <small>
                        {project.available === false
                          ? t('marketUi.filters.directoryUnavailable')
                          : parentPath(project.workspace)}
                      </small>
                    </span>
                  </button>
                );
              })}
              {listed.length === 0 && (
                <p className={styles.projectPopoverEmpty}>{t('marketUi.filters.noProjectMatches')}</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const InstalledContextBar: React.FC<InstalledContextBarProps> = ({
  scopes,
  workspace,
  projects,
  onScopesChange,
  onWorkspaceChange,
}) => {
  const { t } = useTranslation();
  const byProject = scopes.includes('project');
  const scopeOptions: Array<{ value: MarketInstalledScope; label: string; title: string }> = [
    {
      value: 'builtin',
      label: t('marketUi.location.builtinShort'),
      title: t('marketUi.filters.builtinScopeHint'),
    },
    {
      value: 'user',
      label: t('marketUi.location.global'),
      title: t('marketUi.filters.globalScopeHint'),
    },
    {
      value: 'project',
      label: t('marketUi.location.project'),
      title: t('marketUi.filters.projectScopeHint'),
    },
  ];

  const toggleScope = (scope: MarketInstalledScope) => {
    const next = scopes.includes(scope)
      ? scopes.filter((current) => current !== scope)
      : [...scopes, scope];
    onScopesChange(next);
    if (!next.includes('project')) onWorkspaceChange(undefined);
  };

  return (
    <>
      <div className={styles.filterRow} role="group" aria-label={t('marketUi.filters.installLocationAria')}>
        <span className={styles.filterLabel}>{t('marketUi.filters.locationLabel')}</span>
        <button
          type="button"
          className={`${styles.filterChip} ${scopes.length === 0 ? styles.filterChipActive : ''}`}
          aria-pressed={scopes.length === 0}
          onClick={() => {
            onScopesChange([]);
            onWorkspaceChange(undefined);
          }}
        >
          {t('marketUi.filters.allLocations')}
        </button>
        {scopeOptions.map((option) => {
          const active = scopes.includes(option.value);
          return (
            <button
              type="button"
              key={option.value}
              className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
              aria-pressed={active}
              title={option.title}
              onClick={() => toggleScope(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {byProject && projects.length > 0 && (
        <ProjectRow projects={projects} workspace={workspace} onWorkspaceChange={onWorkspaceChange} />
      )}
    </>
  );
};

export default InstalledContextBar;
