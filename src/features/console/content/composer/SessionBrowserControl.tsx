/**
 * SessionBrowserControl —— 输入框底部工具行的「会话浏览器」资源位，新建会话与主会话共用。
 *
 * 会话模式：始终可见。已加入集合为空时显示"选择浏览器…"（有待发送项时显示"添加"），
 * 1 个显示环境名，多个显示图标 + 数量。点开是一个可搜索、限高可滚的列表，
 * 分"当前会话"与"可添加"两段：
 * - 当前会话行显示环境状态与使用情况（来自占用登记；点击使用它的 Worker 可跳转）；
 *   点环境名进入只读配置（用途 / 代理 / 指纹 / 地理位置，复用 EnvStudio 的格式器）。
 * - 可添加行点一下即进入待发送集合（草稿区出现可取消的 `BrowserEnvironmentTags` 标签），
 *   随下一条消息发送；这里不直接改会话，真正加入以后端持久化为准。
 * 新建会话页没有已加入集合，待发送集合就是开场绑定，随首条任务一起创建会话。
 *
 * 浏览器 Worker：只读读数，显示它创建时绑定的环境，没有绑定则为"临时浏览器"。
 * 非浏览器 Worker 由调用方决定不渲染。
 *
 * 面板走 `chrome/Popover`（原生 popover + anchor positioning），与工具行其他药丸同一套外壳。
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Chrome, Loader2, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BrowserEnvironment } from '../../../../../shared/types';
import type { ProxyProfile } from '../../../../../shared/types/proxy';
import { resolveBrowserEnvironmentPurpose } from '../../../../../shared/utils/browser-environment';
import { useBrowserEnvironmentStore } from '../../../../store/browserEnvironmentStore';
import { useOccupancyStore } from '../../../../store/occupancyStore';
import {
  environmentStatusOf,
  browserEnvironmentNameOf,
  geolocationLineOf,
  identityLineOf,
  proxyLabelOf,
  resolveEnvironmentUsage,
  type EnvironmentUsage,
} from '../../../../utils/browserEnvironmentPresentation';
import { Popover } from '../../chrome/Popover';
import type { WorkerRef } from '../../data/vm';
import styles from './sessionBrowserControl.module.css';

// ==================== 读数 ====================

interface EnvironmentRow {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly environment?: BrowserEnvironment;
  readonly usage: EnvironmentUsage;
}

function toRow(
  id: string,
  environment: BrowserEnvironment | undefined,
  usage: EnvironmentUsage,
): EnvironmentRow {
  return {
    id,
    name: environment?.name ?? id,
    purpose: resolveBrowserEnvironmentPurpose(environment ?? {}),
    environment,
    usage,
  };
}

function matchesQuery(row: EnvironmentRow, usageLabel: string, query: string): boolean {
  if (!query) return true;
  const haystack = `${row.name}\n${row.purpose}\n${usageLabel}`.toLowerCase();
  return haystack.includes(query);
}

/** 代理清单只在打开配置详情时按需读取；非 Electron 宿主没有该接口时保持为空。 */
function useProxyProfiles(enabled: boolean): readonly ProxyProfile[] {
  const [proxies, setProxies] = useState<readonly ProxyProfile[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const snapshot = await window.piskie?.configuration?.proxy.read();
        if (alive && snapshot) setProxies(snapshot.proxies);
      } catch {
        if (alive) setProxies([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);
  return proxies;
}

// ==================== 只读配置详情 ====================

const EnvironmentDetails: React.FC<{
  readonly row: EnvironmentRow;
  readonly onBack: () => void;
}> = ({ row, onBack }) => {
  const { t } = useTranslation();
  const proxies = useProxyProfiles(Boolean(row.environment));
  const environment = row.environment;
  const status = environmentStatusOf(environment, t);
  return (
    <div className={styles.details} data-testid="session-browser-details">
      <div className={styles.detailsHead}>
        <button type="button" className={styles.back} onClick={onBack} aria-label={t('sharedUi.browserBinding.session.back')}>
          <ArrowLeft size={13} aria-hidden />
        </button>
        <span className={styles.detailsTitle}>{row.name}</span>
        <span className={styles.dot} data-tone={status.tone} aria-hidden />
        <span className={styles.rowMeta}>{status.label}</span>
      </div>
      <dl className={styles.facts}>
        <dt>{t('sharedUi.browserBinding.session.purpose')}</dt>
        <dd>{row.purpose}</dd>
        {environment && (
          <>
            <dt>{t('sharedUi.browserBinding.session.proxy')}</dt>
            <dd>{proxyLabelOf(proxies, environment.proxyId, t)}</dd>
            <dt>{t('sharedUi.browserBinding.session.identity')}</dt>
            <dd>{identityLineOf(environment, t)}</dd>
            <dt>{t('sharedUi.browserBinding.session.geolocation')}</dt>
            <dd>{geolocationLineOf(environment, t)}</dd>
          </>
        )}
      </dl>
      <span className={styles.readOnlyNote}>{t('sharedUi.browserBinding.session.details')}</span>
    </div>
  );
};

// ==================== 主会话面板 ====================

interface SessionPanelProps {
  readonly agentId?: string;
  readonly joinedIds: readonly string[];
  readonly pendingIds: readonly string[];
  readonly workers: readonly WorkerRef[];
  readonly onPendingChange: (environmentIds: readonly string[]) => void;
  readonly onOpenWorker?: (workerId: string) => void;
  readonly onClose: () => void;
}

const SessionPanel: React.FC<SessionPanelProps> = ({
  agentId, joinedIds, pendingIds, workers, onPendingChange, onOpenWorker, onClose,
}) => {
  const { t } = useTranslation();
  const environments = useBrowserEnvironmentStore((state) => state.environments);
  const isLoading = useBrowserEnvironmentStore((state) => state.isLoading);
  const occupancies = useOccupancyStore((state) => state.occupancies);
  const fetchOccupancies = useOccupancyStore((state) => state.fetchOccupancies);
  const [query, setQuery] = useState('');
  const [detailsId, setDetailsId] = useState<string | null>(null);

  useEffect(() => {
    void fetchOccupancies();
  }, [fetchOccupancies]);

  const usageLabel = useCallback((usage: EnvironmentUsage): string => {
    if (usage.kind === 'idle') return t('sharedUi.browserBinding.session.unused');
    return t('sharedUi.browserBinding.session.usedBy', { name: usage.label });
  }, [t]);

  const joinedRows = useMemo(() => joinedIds.map((id) => {
    const environment = environments.find((item) => item.id === id);
    return toRow(id, environment, resolveEnvironmentUsage(environment ?? { id }, occupancies, agentId, workers));
  }), [agentId, environments, joinedIds, occupancies, workers]);
  const availableRows = useMemo(() => environments
    .filter((environment) => !joinedIds.includes(environment.id))
    .map((environment) => toRow(environment.id, environment, resolveEnvironmentUsage(environment, occupancies, agentId, workers))),
  [agentId, environments, joinedIds, occupancies, workers]);

  const normalized = query.trim().toLowerCase();
  const visibleJoined = joinedRows.filter((row) => matchesQuery(row, usageLabel(row.usage), normalized));
  const visibleAvailable = availableRows.filter((row) => matchesQuery(row, usageLabel(row.usage), normalized));

  const togglePending = (id: string) => {
    onPendingChange(pendingIds.includes(id) ? pendingIds.filter((item) => item !== id) : [...pendingIds, id]);
  };

  const detailsRow = detailsId
    ? [...joinedRows, ...availableRows].find((row) => row.id === detailsId)
    : undefined;
  if (detailsRow) {
    return (
      <div className={styles.panel}>
        <EnvironmentDetails row={detailsRow} onBack={() => setDetailsId(null)} />
      </div>
    );
  }

  const emptyState = (() => {
    if (isLoading && environments.length === 0 && joinedRows.length === 0) return 'loading';
    if (environments.length === 0 && joinedRows.length === 0) return 'empty';
    if (visibleJoined.length === 0 && visibleAvailable.length === 0) return 'noMatches';
    return null;
  })();

  return (
    <div className={styles.panel} role="dialog" aria-label={t('sharedUi.browserBinding.session.title')}>
      <label className={styles.searchBox}>
        <Search size={12} aria-hidden />
        <input
          className={styles.searchInput}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('sharedUi.browserBinding.session.search')}
          aria-label={t('sharedUi.browserBinding.session.search')}
          autoFocus
        />
      </label>
      <div className={styles.list}>
        {emptyState === 'loading' && (
          <div className={styles.status} role="status">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {t('sharedUi.browserBinding.loading')}
          </div>
        )}
        {emptyState === 'empty' && (
          <div className={styles.status} role="status">{t('sharedUi.browserBinding.empty')}</div>
        )}
        {emptyState === 'noMatches' && (
          <div className={styles.status} role="status">{t('sharedUi.browserBinding.session.noMatches')}</div>
        )}
        {visibleJoined.length > 0 && (
          <>
            <div className={styles.sectionLabel}>{t('sharedUi.browserBinding.session.joined')}</div>
            {visibleJoined.map((row) => {
              const status = environmentStatusOf(row.environment, t);
              const usage = row.usage;
              return (
                <div key={row.id} className={styles.row} data-section="joined">
                  <span className={styles.dot} data-tone={status.tone} aria-hidden />
                  <button
                    type="button"
                    className={styles.rowMain}
                    onClick={() => setDetailsId(row.id)}
                    aria-label={t('sharedUi.browserBinding.session.openDetails', { name: row.name })}
                  >
                    <span className={styles.rowName}>{row.name}</span>
                    <span className={styles.rowMeta}>{row.purpose}</span>
                  </button>
                  {usage.kind === 'worker' && onOpenWorker ? (
                    <button
                      type="button"
                      className={styles.usage}
                      data-kind="worker"
                      data-worker-id={usage.workerId}
                      onClick={() => {
                        onClose();
                        onOpenWorker(usage.workerId);
                      }}
                      aria-label={t('sharedUi.browserBinding.session.openWorker', { name: usage.label })}
                    >
                      <span className={styles.usageLabel}>{usageLabel(usage)}</span>
                    </button>
                  ) : (
                    <span className={styles.usage} data-kind={usage.kind}>
                      <span className={styles.usageLabel}>{usageLabel(usage)}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}
        {emptyState === null && visibleAvailable.length === 0 && !normalized && (
          <div className={styles.status} role="status">{t('sharedUi.browserBinding.session.allJoined')}</div>
        )}
        {visibleAvailable.length > 0 && (
          <>
            <div className={styles.sectionLabel}>{t('sharedUi.browserBinding.session.available')}</div>
            {visibleAvailable.map((row) => {
              const status = environmentStatusOf(row.environment, t);
              const pending = pendingIds.includes(row.id);
              const toggleLabel = pending
                ? t('sharedUi.browserBinding.session.removePending', { name: row.name })
                : t('sharedUi.browserBinding.session.addNamed', { name: row.name });
              return (
                <div key={row.id} className={styles.row} data-section="available" data-pending={pending || undefined}>
                  <span className={styles.dot} data-tone={status.tone} aria-hidden />
                  <button
                    type="button"
                    className={styles.rowMain}
                    onClick={() => togglePending(row.id)}
                    aria-label={toggleLabel}
                    aria-pressed={pending}
                  >
                    <span className={styles.rowName}>{row.name}</span>
                    <span className={styles.rowMeta}>
                      {row.usage.kind === 'idle' ? row.purpose : usageLabel(row.usage)}
                    </span>
                  </button>
                  {pending && <span className={styles.badge}>{t('sharedUi.browserBinding.session.pending')}</span>}
                  <button
                    type="button"
                    className={styles.toggle}
                    onClick={() => togglePending(row.id)}
                    aria-label={toggleLabel}
                    aria-pressed={pending}
                  >
                    {pending ? <Check size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};

// ==================== 控件 ====================

const EMPTY_WORKERS: readonly WorkerRef[] = [];

export type SessionBrowserControlProps =
  | {
      readonly mode: 'session';
      /** 会话 ID；新建会话页还没有会话时缺省，此时任何占用都视为会话外 */
      readonly agentId?: string;
      /** 会话当前集合（后端权威投影）；新建会话页为空 */
      readonly joinedIds: readonly string[];
      /** 待随下一条消息发送的环境：主会话进草稿，新建会话页即开场绑定 */
      readonly pendingIds: readonly string[];
      readonly workers?: readonly WorkerRef[];
      readonly onPendingChange: (environmentIds: readonly string[]) => void;
      readonly onOpenWorker?: (workerId: string) => void;
      readonly disabled?: boolean;
    }
  | {
      readonly mode: 'worker';
      /** 浏览器 Worker 创建时绑定的环境；缺省即临时浏览器 */
      readonly environmentId?: string;
    };

export const SessionBrowserControl = memo<SessionBrowserControlProps>((props) => {
  const { t } = useTranslation();
  const environments = useBrowserEnvironmentStore((state) => state.environments);
  const fetchEnvironments = useBrowserEnvironmentStore((state) => state.fetchEnvironments);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    void fetchEnvironments();
  }, [fetchEnvironments]);

  const nameOf = (id: string): string => browserEnvironmentNameOf(environments, id);

  if (props.mode === 'worker') {
    const label = props.environmentId ? nameOf(props.environmentId) : t('sharedUi.browserBinding.session.temporary');
    return (
      <span
        className={styles.trigger}
        data-readonly="true"
        data-named={props.environmentId ? 'true' : undefined}
        title={t('sharedUi.browserBinding.session.readOnly')}
        aria-label={t('sharedUi.browserBinding.session.control')}
        data-testid="session-browser-control"
      >
        <span className={styles.triggerIcon} aria-hidden><Chrome size={12} /></span>
        <span className={styles.triggerLabel}>{label}</span>
      </span>
    );
  }

  const { joinedIds, pendingIds } = props;
  const [single] = joinedIds;
  const label = single === undefined
    ? t(pendingIds.length > 0 ? 'sharedUi.browserBinding.add' : 'sharedUi.browserBinding.choose')
    : joinedIds.length === 1
      ? nameOf(single)
      : t('sharedUi.browserBinding.session.count', { count: joinedIds.length });

  return (
    <Popover
      open={open}
      onClose={close}
      placement="block-start"
      align="start"
      trigger={
        <button
          type="button"
          className={styles.trigger}
          disabled={props.disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('sharedUi.browserBinding.session.control')}
          data-named={joinedIds.length > 0 ? 'true' : undefined}
          data-pending={pendingIds.length > 0 ? 'true' : undefined}
          data-testid="session-browser-control"
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.triggerIcon} aria-hidden><Chrome size={12} /></span>
          <span className={styles.triggerLabel}>{label}</span>
          <ChevronDown size={11} className={styles.triggerChevron} aria-hidden />
        </button>
      }
    >
      {open && (
        <SessionPanel
          agentId={props.agentId}
          joinedIds={joinedIds}
          pendingIds={pendingIds}
          workers={props.workers ?? EMPTY_WORKERS}
          onPendingChange={props.onPendingChange}
          onOpenWorker={props.onOpenWorker}
          onClose={close}
        />
      )}
    </Popover>
  );
});

SessionBrowserControl.displayName = 'SessionBrowserControl';
