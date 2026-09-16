import { memo, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import { resolvePresentationText } from '../data/presentationText';
import { isPendingTranscriptNode, type TranscriptRow as Row } from '../data/transcriptRows';
import { isActiveStatus } from '../data/status';
import type { WorkerRef } from '../data/vm';
import { formatActivityDuration } from './formatActivityDuration';
import { ToolTypeIcon } from './ToolTypeIcon';
import activeTextStyles from './activeText.module.css';
import styles from './Transcript.module.css';

interface TranscriptRowProps {
  readonly row: Row;
  readonly renderNode: (node: TranscriptNode) => ReactNode;
  readonly openGroups: ReadonlySet<string>;
  readonly deferredNodeIds: ReadonlySet<string>;
  readonly onToggle: (id: string, anchor: HTMLElement) => void;
  readonly toolsActive: boolean;
  readonly workers?: readonly WorkerRef[];
}

export const TranscriptRow = memo<TranscriptRowProps>(function TranscriptRow({
  row, renderNode, openGroups, deferredNodeIds, onToggle, toolsActive, workers,
}) {
  const { t } = useTranslation();
  if (row.kind === 'node') return renderNode(row.node);

  const open = openGroups.has(row.id);
  let text: string;
  let running = false;
  if (row.kind === 'tools') {
    const latest = row.latest;
    const title = t(latest.titleKey, latest.titleArgs ?? {});
    const summary = latest.kind === 'tool' && latest.fileOp?.kind === 'read'
      ? latest.fileOp.path
      : latest.summary && resolvePresentationText(latest.summary, (key, values) => t(key, values ?? {}));
    text = summary ? `${title} · ${summary}` : title;
    running = toolsActive;
  } else {
    text = row.durationMs === undefined
      ? t('transcript.executionProcess')
      : t('transcript.elapsedProcess', { elapsed: formatActivityDuration(row.durationMs, t) });
  }

  const renderCell = (node: TranscriptNode) => (
    <div key={node.id} className={styles.cell} data-node-id={node.id} data-deferred={deferredNodeIds.has(node.id) || undefined}>
      {renderNode(node)}
    </div>
  );
  const pendingNodes = row.kind === 'tools' ? row.nodes.filter(isPendingTranscriptNode) : [];
  const activeWorkers = !open && row.kind === 'process' ? row.rows.flatMap((child) => {
    if (child.kind !== 'node' || child.node.kind !== 'worker') return [];
    const node = child.node;
    const worker = workers?.find((candidate) => candidate.id === node.workerId);
    return worker && isActiveStatus(worker.status) ? [node] : [];
  }) : [];

  return (
    <div className={styles.group} data-transcript-group={row.kind} data-group-id={row.id}>
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        onClick={(event) => onToggle(row.id, event.currentTarget)}
      >
        <span className={styles.groupLeading} aria-hidden>
          {row.kind === 'tools'
            ? <ToolTypeIcon cell={row.latest} />
            : <ChevronRight size={14} className={styles.groupCaret} />}
        </span>
        <span className={`${styles.groupLabel} ${running ? activeTextStyles.text : ''}`} title={text}>
          {text}
        </span>
      </button>
      {open && (
        <div className={styles.groupBody}>
          {row.kind === 'tools' ? row.nodes.map(renderCell) : row.rows.map((child) => (
            <div
              key={child.id}
              className={styles.cell}
              data-node-id={child.kind === 'node' ? child.node.id : undefined}
              data-deferred={child.kind === 'node' && deferredNodeIds.has(child.node.id) || undefined}
            >
              <TranscriptRow
                row={child}
                renderNode={renderNode}
                openGroups={openGroups}
                deferredNodeIds={deferredNodeIds}
                onToggle={onToggle}
                toolsActive={false}
                workers={workers}
              />
            </div>
          ))}
        </div>
      )}
      {activeWorkers.length > 0 && (
        <div className={styles.groupBody}>
          {activeWorkers.map((node) => (
            <div key={node.id} data-worker-summary={node.id}>
              {renderNode(node)}
            </div>
          ))}
        </div>
      )}
      {!open && pendingNodes.length > 0 && (
        <div className={styles.groupBody}>{pendingNodes.map(renderCell)}</div>
      )}
    </div>
  );
});
