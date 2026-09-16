import { memo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FileChangeRound } from '../data/fileChanges';
import { basename } from '../data/review';
import { useFileChanges } from '../data/useFileChanges';
import { RecordedFileReview } from './ReviewPanel';
import styles from './FileChangesReview.module.css';
import sidebarStyles from './threads.module.css';

const COLLAPSED_FILE_LIMIT = 5;

type Selection = { readonly roundId: string; readonly path: string };

export const FileChangesReview = memo<{
  readonly agentId: string;
  readonly includeWorkers: boolean;
}>(({ agentId, includeWorkers }) => {
  const { t } = useTranslation();
  const view = useFileChanges(agentId, includeWorkers);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedRounds, setExpandedRounds] = useState<ReadonlySet<string>>(() => new Set());
  const latest = view.rounds[0];
  const selectedRound = view.rounds.find((round) => round.id === selection?.roundId) ?? latest;
  const selectedFile = selectedRound?.files.find((file) => file.path === selection?.path) ?? selectedRound?.files[0];
  if (!selection && selectedRound && selectedFile && !view.loading) {
    setSelection({ roundId: selectedRound.id, path: selectedFile.path });
  }

  const roundFiles = (round: FileChangeRound, recent: boolean) => {
    const expanded = expandedRounds.has(round.id);
    const hiddenCount = Math.max(0, round.files.length - COLLAPSED_FILE_LIMIT);
    const files = expanded ? round.files : round.files.slice(0, COLLAPSED_FILE_LIMIT);
    return <section key={round.id} className={styles.round}>
      <div className={styles.roundHeading}>
        <span>{t(recent ? 'sessionWorkbenchUi.review.latestRound' : 'sessionWorkbenchUi.review.earlierRound')}</span>
        {round.title && <span className={styles.roundTitle} title={round.title}>{round.title}</span>}
      </div>
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          className={styles.file}
          title={file.path}
          aria-pressed={selectedRound?.id === round.id && selectedFile?.path === file.path}
          onClick={() => setSelection({ roundId: round.id, path: file.path })}
        >
          <span className={styles.fileLabel}>
            <span className={styles.fileName}>{basename(file.path)}</span>
            <span className={styles.filePath}>{file.path}</span>
          </span>
          <span className={styles.stat}>
            <span className={styles.added}>+{file.added}</span>
            <span className={styles.removed}>-{file.removed}</span>
          </span>
        </button>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          className={sidebarStyles.moreRow}
          aria-expanded={expanded}
          onClick={() => setExpandedRounds((current) => {
            const next = new Set(current);
            if (next.has(round.id)) next.delete(round.id);
            else next.add(round.id);
            return next;
          })}
        >
          {expanded
            ? t('sessionWorkbenchUi.sidebar.fewerRows')
            : t('sessionWorkbenchUi.sidebar.moreRows', { count: hiddenCount })}
        </button>
      )}
    </section>;
  };

  return (
    <div className={styles.collection}>
      <nav className={styles.sidebar} aria-label={t('sessionWorkbenchUi.review.changedFiles')}>
        {latest && roundFiles(latest, true)}
        {view.rounds.length > 1 && (
          <button type="button" className={styles.historyToggle} aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
            <span>{t(historyOpen ? 'sessionWorkbenchUi.review.fewerRounds' : 'sessionWorkbenchUi.review.moreRounds')}</span>
            {historyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
        {historyOpen && view.rounds.slice(1).map((round) => roundFiles(round, false))}
        {view.loading && !view.error && <div className={styles.status}>{t('sessionWorkbenchUi.review.loadingChanges')}</div>}
        {view.error && (
          <div className={styles.status} role="status">
            {t('sessionWorkbenchUi.review.changesLoadFailed')}
            <button type="button" className={styles.historyToggle} onClick={view.retry}>{t('sessionWorkbenchUi.review.retryChanges')}</button>
          </div>
        )}
      </nav>
      <div className={styles.detail}>
        {selectedFile ? (
          <RecordedFileReview
            key={JSON.stringify([selectedRound!.id, selectedFile.path])}
            file={selectedFile}
            roundTitle={selectedRound!.title}
            onRevealPath={(path) => void window.piskie.desktop.system.revealPath(path)}
          />
        ) : <div className={styles.status}>{t(view.loading ? 'sessionWorkbenchUi.review.loadingChanges' : 'sessionWorkbenchUi.review.noChanges')}</div>}
      </div>
    </div>
  );
});

FileChangesReview.displayName = 'FileChangesReview';
