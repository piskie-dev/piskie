import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, GitBranch, Loader2, Plus, Search } from 'lucide-react';
import type { WorkspaceGitInfo } from '../../../../../shared/electron-contracts/desktop';
import { resolvePresentationText, type PresentationText } from '../../../../i18n/presentationText';
import styles from './workspaceBar.module.css';

interface BranchMenuProps {
  readonly git: WorkspaceGitInfo;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly creating: boolean;
  readonly switchError?: PresentationText;
  readonly createError?: PresentationText;
  readonly clearErrors: () => void;
  readonly switchBranch: (branch: string) => Promise<boolean>;
  readonly createBranch: (branch: string) => Promise<boolean>;
  readonly onSwitched: () => void;
}

/** Keeps lowercase search offsets aligned with the original text, including expanding Unicode case mappings. */
function branchMatch(name: string, query: string): { matches: boolean; label: ReactNode } {
  if (!query) return { matches: true, label: name };
  const folded = name.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const ranges: [number, number][] = [];
  for (let start = folded.indexOf(needle); start !== -1; start = folded.indexOf(needle, start + needle.length)) {
    ranges.push([start, start + needle.length]);
  }
  if (!ranges.length) return { matches: false, label: name };
  const offsets: { start: number; end: number }[] = [];
  let originalOffset = 0;
  for (const character of name) {
    for (let index = 0; index < character.toLocaleLowerCase().length; index++) {
      offsets.push({ start: originalOffset, end: originalOffset + character.length });
    }
    originalOffset += character.length;
  }
  const label: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    const from = Math.max(cursor, offsets[start]!.start);
    const to = offsets[end - 1]!.end;
    if (to <= cursor) continue;
    label.push(name.slice(cursor, from));
    label.push(<mark key={from} className={styles.match}>{name.slice(from, to)}</mark>);
    cursor = to;
  }
  label.push(name.slice(cursor));
  return { matches: true, label };
}

export function BranchMenu({ git, loading, busy, creating, switchError, createError, clearErrors, switchBranch, createBranch, onSwitched }: BranchMenuProps) {
  const { t } = useTranslation();
  const nameId = useId();
  const errorId = useId();
  const [view, setView] = useState<'list' | 'create'>('list');
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The native popover becomes focusable after its parent's effect opens it.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [view]);
  const currentName = git.head.kind === 'detached' ? undefined : git.head.name;
  const baseLabel = git.head.kind === 'detached' ? git.head.commit.slice(0, 7) : git.head.name;
  const names = currentName && !git.branches.includes(currentName) ? [currentName, ...git.branches] : git.branches;
  const branches = names.map((branch) => ({ branch, ...branchMatch(branch, search) }))
    .filter(({ matches }) => matches)
    .sort((a, b) => !search && (a.branch === currentName || b.branch === currentName)
      ? Number(b.branch === currentName) - Number(a.branch === currentName)
      : a.branch.localeCompare(b.branch));

  return (
    <div className={styles.branchMenu} role="dialog" aria-label={t('sessionWorkbenchUi.composer.localBranches')} aria-busy={loading || busy}>
      {view === 'create' ? (
        <form className={styles.createForm} onSubmit={async (event) => {
          event.preventDefault();
          if (busy || loading || !name.trim()) return;
          if (await createBranch(name)) { setSearch(''); setView('list'); }
        }}>
          <div className={styles.createHeader}>
            <strong>{t('sessionWorkbenchUi.composer.createBranchTitle')}</strong>
            <button type="button" className={styles.back} disabled={busy} onClick={() => { clearErrors(); setView('list'); }}>
              <ArrowLeft size={13} aria-hidden />{t('sessionWorkbenchUi.composer.backToBranches')}
            </button>
          </div>
          <p className={styles.base} title={baseLabel}><GitBranch size={13} aria-hidden />
            <span className={styles.label}>{t(git.head.kind === 'unborn'
              ? 'sessionWorkbenchUi.composer.createUnbornBranchBase' : 'sessionWorkbenchUi.composer.createBranchBase', { base: baseLabel })}</span>
          </p>
          <label className={styles.nameLabel} htmlFor={nameId}>{t('sessionWorkbenchUi.composer.branchName')}</label>
          <input ref={inputRef} id={nameId} type="text" autoFocus autoComplete="off" spellCheck={false} className={styles.search} value={name}
            placeholder={t('sessionWorkbenchUi.composer.branchNamePlaceholder')} disabled={busy}
            aria-invalid={!!createError} aria-describedby={createError ? errorId : undefined}
            onChange={(event) => { setName(event.target.value); clearErrors(); }} />
          {createError && <div id={errorId} className={styles.error} role="alert">{resolvePresentationText(createError, t)}</div>}
          <div className={styles.createActions}>
            <button type="submit" className={styles.createSubmit} disabled={busy || loading || !name.trim()}>
              {creating ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <GitBranch size={13} aria-hidden />}
              {t(creating ? 'sessionWorkbenchUi.composer.creatingBranch' : 'sessionWorkbenchUi.composer.createAndSwitchBranch')}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className={styles.searchWrap}>
            <Search size={14} aria-hidden />
            <input ref={inputRef} type="search" autoFocus className={styles.search} value={search} disabled={busy}
            aria-label={t('sessionWorkbenchUi.composer.searchBranches')} placeholder={t('sessionWorkbenchUi.composer.searchBranches')}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                event.currentTarget.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
              }
            }} />
          </div>
          <div className={styles.branchList} role="menu" aria-label={t('sessionWorkbenchUi.composer.localBranches')}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              event.preventDefault();
              buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
            }}>
            {branches.map(({ branch, label }) => {
              const current = currentName === branch;
              return (
                <button key={branch} type="button" role="menuitemradio" aria-checked={current} title={branch}
                  className={`${styles.option} ${styles.branchOption}`} data-selected={current || undefined}
                  disabled={busy || loading || (current && git.head.kind === 'unborn')}
                  onClick={async () => { if (await switchBranch(branch)) onSwitched(); }}>
                  <GitBranch size={14} className={styles.branchIcon} aria-hidden />
                  <span className={styles.branchCopy}>
                    <span className={styles.label}>{label}</span>
                    {current && <span className={styles.branchStatus}>{t(git.dirtyFileCount
                      ? 'sessionWorkbenchUi.composer.uncommittedFiles' : 'sessionWorkbenchUi.composer.cleanWorkspace', { count: git.dirtyFileCount })}</span>}
                  </span>
                  {current && <Check size={14} aria-label={t('sessionWorkbenchUi.composer.currentBranch')} />}
                </button>
              );
            })}
            {branches.length === 0 && <div className={styles.note}>{t(names.length ? 'sessionWorkbenchUi.composer.noBranchMatches' : 'sessionWorkbenchUi.composer.noLocalBranches')}</div>}
          </div>
          {switchError && <div className={styles.error} role="alert">{resolvePresentationText(switchError, t)}</div>}
          <div className={styles.branchFooter}>
            <button type="button" className={`${styles.option} ${styles.createEntry}`} disabled={busy || loading}
              onClick={() => { setName(search); clearErrors(); setView('create'); }}>
              <Plus size={14} aria-hidden />{t('sessionWorkbenchUi.composer.createBranchEntry')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
