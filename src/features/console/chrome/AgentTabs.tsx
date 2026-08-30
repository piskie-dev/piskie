/** Agent/worker 导航标签；Dock 与 Codex 共用同一套紧凑视觉。 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronLeft, ChevronRight, Globe, TerminalSquare } from 'lucide-react';

import type { SubagentMode } from '../../../../shared/types';
import type { StatusKey } from '../data/vm';
import { StatusBadge } from './StatusBadge';
import styles from './agentTabs.module.css';

const COMPACT_THRESHOLD = 7;

const MODE_ICON: Record<SubagentMode, typeof Globe> = {
  browser: Globe,
  local: TerminalSquare,
};

/** `workerId === undefined` 即主会话标签。 */
export interface AgentTabItem {
  readonly workerId?: string;
  readonly label: string;
  readonly mode?: SubagentMode;
  readonly status: StatusKey;
  /** false 时仅作为当前会话标识，不提供选择动作。 */
  readonly selectable?: boolean;
}

export interface AgentTabsProps {
  readonly items: readonly AgentTabItem[];
  /** undefined = 主会话标签处于当前态。 */
  readonly selectedWorkerId?: string;
  readonly onSelect: (workerId?: string) => void;
}

const MAIN_KEY = '__main__';
const INITIAL_PAGING = { overflowing: false, canPrevious: false, canNext: false };

export const AgentTabs = memo<AgentTabsProps>(({ items, selectedWorkerId, onSelect }) => {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const [paging, setPaging] = useState(INITIAL_PAGING);

  const syncPaging = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;

    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    const next = {
      overflowing: maxScroll > 1,
      canPrevious: track.scrollLeft > 1,
      canNext: track.scrollLeft < maxScroll - 1,
    };
    setPaging((current) => (
      current.overflowing === next.overflowing
      && current.canPrevious === next.canPrevious
      && current.canNext === next.canNext
        ? current
        : next
    ));
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    syncPaging();
    track.addEventListener('scroll', syncPaging, { passive: true });
    window.addEventListener('resize', syncPaging);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncPaging);
    observer?.observe(track);

    return () => {
      track.removeEventListener('scroll', syncPaging);
      window.removeEventListener('resize', syncPaging);
      observer?.disconnect();
    };
  }, [items, syncPaging]);

  useEffect(() => {
    const selected = trackRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    selected?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [items, paging.overflowing, selectedWorkerId]);

  const scrollByPage = useCallback((direction: -1 | 1) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({ left: direction * Math.max(track.clientWidth * 0.72, 200), behavior: 'smooth' });
  }, []);

  const compact = items.length >= COMPACT_THRESHOLD;

  return (
    <div
      className={styles.tabs}
      data-compact={compact ? 'true' : undefined}
    >
      {paging.overflowing && (
        <button
          type="button"
          className={styles.page}
          disabled={!paging.canPrevious}
          onClick={() => scrollByPage(-1)}
          aria-label={t('sessionWorkbenchUi.mode.previousPage')}
        >
          <ChevronLeft size={11} />
        </button>
      )}

      <div ref={trackRef} className={styles.track} role="tablist">
        {items.map((item) => {
          const Icon = item.mode ? (MODE_ICON[item.mode] ?? TerminalSquare) : Bot;
          const selected = item.workerId === selectedWorkerId;
          const selectable = item.selectable !== false;

          return (
            <button
              key={item.workerId ?? MAIN_KEY}
              type="button"
              role="tab"
              aria-selected={selected}
              className={styles.tab}
              data-selected={selected ? 'true' : undefined}
              disabled={!selectable}
              onClick={selectable ? () => onSelect(item.workerId) : undefined}
              title={item.label}
            >
              <Icon size={11} />
              <span className={styles.label}>{item.label}</span>
              <StatusBadge status={item.status} dotOnly />
            </button>
          );
        })}
      </div>

      {paging.overflowing && (
        <button
          type="button"
          className={styles.page}
          disabled={!paging.canNext}
          onClick={() => scrollByPage(1)}
          aria-label={t('sessionWorkbenchUi.mode.nextPage')}
        >
          <ChevronRight size={11} />
        </button>
      )}
    </div>
  );
});

AgentTabs.displayName = 'AgentTabs';
