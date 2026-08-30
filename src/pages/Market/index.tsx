import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import type {
  MarketEntry,
  MarketEntryKind,
  MarketInstalledItem,
  MarketInstallRequest,
  MarketSource,
} from '@shared/types/market';
import type { McpServerConfig, McpServerInfo } from '@shared/types/mcp';
import { projectDisplayName } from '@shared/types/project';

import { subscribeToMarketChanges, useMarketStore } from '../../store/marketStore';
import {
  messageText,
  rawText,
  resolvePresentationText,
  type PresentationText,
} from '../../i18n/presentationText';
import { CatalogSyncHint } from './CatalogSyncStatus';
import CapabilityDetailPane from './CapabilityDetailPane';
import CapabilityListItem from './CapabilityListItem';
import InstalledContextBar from './InstalledContextBar';
import InstalledListItem from './InstalledListItem';
import InstallScopeDialog from './InstallScopeDialog';
import type { McpInstallProbeReceipt } from './McpLiveStatusSection';
import SourceFilter from './SourceFilter';
import SourceManagerDialog from './SourceManagerDialog';
import {
  MARKET_PAGE_SIZE,
  capabilityLocations,
  installedItemMatchesEntry,
  installedQueryForEntry,
  marketCatalogNotice,
  marketCatalogSurface,
  marketPagination,
  marketViewFromParam,
  type CapabilityLocation,
  type MarketView,
} from './market-workbench-model';
import styles from './market.module.css';

function currentFilterRequestKey(view: MarketView): string {
  const state = useMarketStore.getState();
  return JSON.stringify([
    view,
    state.query,
    state.kinds,
    state.sourceIds,
    state.installedScopes,
    state.installedWorkspace ?? null,
  ]);
}

const Market: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  /* 瞬时提示条与确认小弹窗(项目风格,替换 antd message/modal) */
  const [flash, setFlash] = useState<{
    text: PresentationText;
    tone: 'calm' | 'hold' | 'halt';
  } | null>(null);
  const [confirmAsk, setConfirmAsk] = useState<{
    title: PresentationText;
    body: PresentationText;
    okText: PresentationText;
    danger?: boolean;
    onOk?: () => Promise<void> | void;
  } | null>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const flashOk = (text: PresentationText) => setFlash({ text, tone: 'calm' });
  const flashWarn = (text: PresentationText) => setFlash({ text, tone: 'hold' });
  const flashErr = (text: PresentationText) => setFlash({ text, tone: 'halt' });
  const present = (text: PresentationText): string => (
    resolvePresentationText(text, (key, values) => t(key, values ?? {}))
  );
  const externalOrMessage = (external: string | null | undefined, key: string): PresentationText => (
    external ? rawText(external) : messageText(key)
  );

  const flashDockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 4000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  /* 提示条走 top layer(manual popover),弹窗打开时反馈也可见 */
  useEffect(() => {
    const dock = flashDockRef.current;
    if (!dock) return;
    const isOpen = dock.matches(':popover-open');
    if (flash && !isOpen) dock.showPopover();
    if (!flash && isOpen) dock.hidePopover();
  }, [flash]);

  useEffect(() => {
    const dialog = confirmRef.current;
    if (!dialog) return;
    dialog.setAttribute('closedby', 'any');
    if (confirmAsk && !dialog.open) dialog.showModal();
    if (!confirmAsk && dialog.open) dialog.close();
  }, [confirmAsk]);
  const {
    entries,
    installedItems,
    sources,
    projects,
    selectedEntry,
    selectedInstalled,
    query,
    kinds,
    sourceIds,
    installedScopes,
    installedWorkspace,
    catalogCount,
    total,
    catalogOffset,
    installedTotal,
    installedCount,
    installedOffset,
    updateCount,
    stale,
    warnings,
    catalogLoading,
    installedLoading,
    catalogInitialized,
    installedInitialized,
    refreshing,
    catalogSync,
    installingEntryId,
    managingItemId,
    catalogError,
    installedError,
    initializeCatalog,
    fetchCatalog,
    fetchInstalled,
    refreshCatalog,
    setQuery,
    setKinds,
    setSourceIds,
    setInstalledScopes,
    setInstalledWorkspace,
    selectEntry,
    selectInstalled,
    install,
    manage,
    fetchProjects,
    addSource,
    removeSource,
  } = useMarketStore();

  const requestedQuery = searchParams.get('query')?.trim() ?? '';
  const requestedKindValue = searchParams.get('kind');
  const requestedKind = requestedKindValue === 'skill'
    || requestedKindValue === 'mcp'
    || requestedKindValue === 'plugin'
    ? requestedKindValue
    : undefined;
  const requestedView = marketViewFromParam(searchParams.get('view'));
  const requestedWorkspace = searchParams.get('workspace')?.trim() || undefined;

  const [activeView, setActiveView] = useState<MarketView>(requestedView);
  const [searchValue, setSearchValue] = useState(requestedQuery || query);
  const [installEntry, setInstallEntry] = useState<MarketEntry | null>(null);
  const [installTarget, setInstallTarget] = useState<MarketInstalledItem | null>(null);
  const [sourceManagerOpen, setSourceManagerOpen] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [configuringItemId, setConfiguringItemId] = useState<string | null>(null);
  const [editingMcp, setEditingMcp] = useState<McpServerInfo | null>(null);
  const [editingMcpLocationKey, setEditingMcpLocationKey] = useState<string>();
  const [editingMcpRegistryName, setEditingMcpRegistryName] = useState<string>();
  const [savingMcp, setSavingMcp] = useState(false);
  /** 安装位置表的数据在别处被改动后，用它触发重新读取 */
  const [locationEpoch, setLocationEpoch] = useState(0);
  const [locationFetch, setLocationFetch] = useState<{ key: string; records: MarketInstalledItem[] }>();
  const [detailEntryFetch, setDetailEntryFetch] = useState<{ key: string; entry: MarketEntry | null }>();
  const [probeReceipts, setProbeReceipts] = useState<Record<string, McpInstallProbeReceipt>>({});
  const initialized = useRef(false);
  const lastFilterRequestKey = useRef<string | null>(null);
  const listViewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (requestedQuery && requestedQuery !== query) setQuery(requestedQuery);
    if (requestedKind && (kinds.length !== 1 || kinds[0] !== requestedKind)) setKinds([requestedKind]);
    lastFilterRequestKey.current = currentFilterRequestKey(activeView);
    void Promise.all([
      initializeCatalog(),
      fetchInstalled({ updatesOnly: requestedView === 'updates' }),
      fetchProjects(),
    ]);
  }, [
    activeView,
    fetchInstalled,
    fetchProjects,
    initializeCatalog,
    kinds,
    query,
    requestedKind,
    requestedQuery,
    requestedView,
    setKinds,
    setQuery,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchValue.trim()), 260);
    return () => window.clearTimeout(timer);
  }, [searchValue, setQuery]);

  useEffect(() => subscribeToMarketChanges(), []);

  useEffect(() => {
    if (requestedView === 'marketplace' || !requestedQuery || !installedInitialized || selectedInstalled) return;
    const candidates = installedItems.filter((item) => !requestedKind || item.kind === requestedKind);
    const first = candidates.find((item) => item.name.toLowerCase() === requestedQuery.toLowerCase())
      ?? candidates[0];
    if (first) selectInstalled(first.id);
  }, [
    installedInitialized,
    installedItems,
    requestedKind,
    requestedQuery,
    requestedView,
    selectInstalled,
    selectedInstalled,
  ]);

  useEffect(() => {
    const requestKey = currentFilterRequestKey(activeView);
    if (lastFilterRequestKey.current === requestKey) return;
    lastFilterRequestKey.current = requestKey;
    listViewportRef.current?.scrollTo({ top: 0 });
    if (activeView === 'marketplace') {
      void fetchCatalog({ offset: 0 });
    } else {
      void fetchInstalled({ offset: 0, updatesOnly: activeView === 'updates' });
    }
  }, [
    activeView,
    fetchCatalog,
    fetchInstalled,
    installedScopes,
    installedWorkspace,
    kinds,
    query,
    sourceIds,
  ]);

  // 详情不分「从市场点开」还是「从已安装点开」：两边都把同一个能力的安装记录取齐
  const detailAnchor: { key: string; entry: MarketEntry | null; item: MarketInstalledItem | null } =
    activeView === 'marketplace'
      ? { key: selectedEntry ? `entry:${selectedEntry.id}` : '', entry: selectedEntry, item: null }
      : {
          key: selectedInstalled && selectedInstalled.origin !== 'plugin' ? `item:${selectedInstalled.id}` : '',
          entry: null,
          item: selectedInstalled,
        };
  const wantsLocations = detailAnchor.key !== '' && !(detailAnchor.entry && !detailAnchor.entry.installed);
  const locationRecords = wantsLocations && locationFetch?.key === detailAnchor.key ? locationFetch.records : [];
  const locationsLoading = wantsLocations && locationFetch?.key !== detailAnchor.key;

  useEffect(() => {
    const { key, entry, item } = detailAnchor;
    if (!key || (entry && !entry.installed)) return;
    let cancelled = false;
    void window.piskie.capabilities.market.installed({
      query: entry ? installedQueryForEntry(entry) : item?.name,
      kinds: [entry?.kind ?? item?.kind].filter(Boolean) as MarketEntryKind[],
      limit: 200,
    })
      .then((response) => response.items)
      .catch(() => [] as MarketInstalledItem[])
      .then((items) => {
        if (cancelled) return;
        const sameCapability = items.filter((candidate) => candidate.origin !== 'plugin' && (
          entry
            ? installedItemMatchesEntry(candidate, entry)
            : candidate.kind === item?.kind && candidate.name === item.name
        ));
        setLocationFetch({
          key,
          records: item && !sameCapability.some((candidate) => candidate.id === item.id)
            ? [...sameCapability, item]
            : sameCapability,
        });
      });
    return () => {
      cancelled = true;
    };
    // detailAnchor 每次渲染都是新对象，按它的 key 订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailAnchor.key, locationEpoch]);

  // 从已安装点开时，把市场条目也补上，让两条路径看到同一份内容
  const marketEntryKey = activeView === 'marketplace' ? '' : selectedInstalled?.marketEntryId ?? '';

  useEffect(() => {
    if (!marketEntryKey) return;
    let cancelled = false;
    void window.piskie.capabilities.market.detail(marketEntryKey)
      .catch(() => null)
      .then((entry) => {
        if (!cancelled) setDetailEntryFetch({ key: marketEntryKey, entry });
      });
    return () => {
      cancelled = true;
    };
  }, [marketEntryKey]);

  const closeInstall = () => {
    setInstallEntry(null);
    setInstallTarget(null);
  };

  const openInstall = (entry: MarketEntry, target?: MarketInstalledItem) => {
    setInstallTarget(target ?? null);
    setInstallEntry(entry);
  };

  const handleInstall = async (request: MarketInstallRequest) => {
    const result = await install(request);
    if (!result) {
      flashErr(externalOrMessage(useMarketStore.getState().error, 'marketUi.feedback.installFailed'));
      return;
    }
    const succeeded = result.targets.filter((target) => target.ok);
    const failed = result.targets.filter((target) => !target.ok);
    const installWarnings = succeeded.flatMap((target) => target.warning ? [target.warning] : []);
    if (failed.length === 0) {
      if (installWarnings.length > 0) {
        flashWarn(rawText(installWarnings[0]!));
      } else {
        flashOk(succeeded.length === 1 && succeeded[0]!.scope === 'user'
          ? messageText('marketUi.feedback.installedGlobally', { name: rawText(result.name) })
          : messageText('marketUi.feedback.installedToProjects', {
              name: rawText(result.name),
              count: succeeded.length,
            }));
      }
      closeInstall();
      return;
    }
    if (succeeded.length > 0) {
      flashWarn(messageText('marketUi.feedback.partialInstall', {
        name: rawText(result.name),
        succeeded: succeeded.length,
        failed: failed.length,
      }));
      setConfirmAsk({
        title: messageText('marketUi.feedback.partialInstallTitle'),
        body: messageText('marketUi.feedback.partialInstallBody', {
          details: rawText(failed
            .map((target) => [target.workspace, target.error].filter(Boolean).join(': ') || '-')
            .join('\n')),
        }),
        okText: messageText('marketUi.feedback.acknowledge'),
      });
      closeInstall();
      return;
    }
    flashErr(externalOrMessage(failed[0]?.error, 'marketUi.feedback.installFailed'));
  };

  const openInstalledForEntry = async (entry: MarketEntry) => {
    const lookupQuery = installedQueryForEntry(entry);
    setActiveView('installed');
    setSearchValue(lookupQuery);
    setQuery(lookupQuery);
    setKinds([entry.kind]);
    setInstalledScopes([]);
    setInstalledWorkspace(undefined);
    await fetchInstalled({ offset: 0, updatesOnly: false });
    const match = useMarketStore.getState().installedItems.find((item) => (
      installedItemMatchesEntry(item, entry)
    ));
    selectInstalled(match?.id ?? null);
    if (!match) {
      flashWarn(messageText('marketUi.feedback.installRecordMissing', { name: rawText(entry.name) }));
    }
  };

  const openPluginOwner = async (item: MarketInstalledItem) => {
    if (!item.plugin) return;
    setActiveView('installed');
    setSearchValue(item.plugin);
    setQuery(item.plugin);
    setKinds(['plugin']);
    setInstalledScopes([item.scope]);
    await fetchInstalled({ offset: 0, updatesOnly: false });
    const owner = useMarketStore.getState().installedItems.find((candidate) => (
      candidate.kind === 'plugin'
      && candidate.name === item.plugin
      && candidate.scope === item.scope
      && candidate.workspace === item.workspace
    ));
    if (owner) selectInstalled(owner.id);
    else {
      flashWarn(messageText('marketUi.feedback.pluginRecordMissing', {
        plugin: rawText(item.plugin),
      }));
    }
  };

  const configureMcp = async (location: CapabilityLocation) => {
    const item = location.record;
    if (item.kind !== 'mcp' || item.scope === 'builtin') return;
    setConfiguringItemId(item.id);
    setEditingMcpRegistryName(undefined);
    try {
      const workspace = item.workspace;
      const [response, marketEntryResponse] = await Promise.all([
        window.piskie.capabilities.mcp.list({
          scope: workspace ? 'all' : item.scope,
          workspace,
        }),
        item.marketEntryId
          ? window.piskie.capabilities.market.detail(item.marketEntryId)
          : Promise.resolve(null),
      ]);
      const targetScope = item.scope === 'project' ? 'project' : 'user';
      const target = response.find((server) => (
        server.name === item.name
        && server.scope === targetScope
        && server.origin === item.origin
        && server.plugin === item.plugin
        && (server.scope !== 'project' || server.workspace === item.workspace)
      ));
      if (!target) {
        flashErr(messageText('marketUi.feedback.installLayerChanged', { name: rawText(item.name) }));
        return;
      }
      setEditingMcpRegistryName(marketEntryResponse?.name);
      setEditingMcpLocationKey(location.key);
      setEditingMcp(target);
    } catch (configError) {
      flashErr(rawText(configError instanceof Error ? configError.message : String(configError)));
    } finally {
      setConfiguringItemId(null);
    }
  };

  const closeMcpEditor = () => {
    setEditingMcp(null);
    setEditingMcpLocationKey(undefined);
    setEditingMcpRegistryName(undefined);
  };

  const saveMcpConfig = async (config: McpServerConfig): Promise<boolean> => {
    if (!editingMcp || editingMcp.origin !== 'explicit') return false;
    setSavingMcp(true);
    try {
      const response = await window.piskie.capabilities.mcp.add({
        name: editingMcp.name,
        scope: editingMcp.scope,
        workspace: editingMcp.scope === 'project' ? editingMcp.workspace : undefined,
        config,
        force: true,
      });
      const warnings = response.onboarding.warnings;
      if (warnings.length > 0) {
        flashWarn(messageText('marketUi.feedback.configSavedWithWarnings', {
          name: rawText(editingMcp.name),
          warnings: rawText(warnings.join('; ')),
        }));
      } else {
        flashOk(messageText('marketUi.feedback.configSavedAndChecked', {
          name: rawText(editingMcp.name),
        }));
      }
      const selectedId = selectedInstalled?.id;
      closeMcpEditor();
      setLocationEpoch((epoch) => epoch + 1);
      await Promise.all([
        fetchInstalled({ offset: installedOffset, updatesOnly: activeView === 'updates' }),
        fetchCatalog({ offset: catalogOffset }),
      ]);
      if (selectedId) selectInstalled(selectedId);
      return true;
    } catch (saveError) {
      flashErr(rawText(saveError instanceof Error ? saveError.message : String(saveError)));
      return false;
    } finally {
      setSavingMcp(false);
    }
  };

  const openPluginMember = async (
    owner: MarketInstalledItem,
    member: { kind: 'skill' | 'mcp'; name: string },
  ) => {
    setActiveView('installed');
    setSearchValue(member.name);
    setQuery(member.name);
    setKinds([member.kind]);
    setInstalledScopes([]);
    await fetchInstalled({ offset: 0, updatesOnly: false });
    const match = useMarketStore.getState().installedItems.find((candidate) => (
      candidate.kind === member.kind
      && candidate.name === member.name
      && candidate.plugin === owner.name
      && candidate.workspace === owner.workspace
    ));
    if (match) selectInstalled(match.id);
    else {
      flashWarn(messageText('marketUi.feedback.installRecordMissing', { name: rawText(member.name) }));
    }
  };

  const updateInstalled = async (item: MarketInstalledItem) => {
    if (!item.marketEntryId) {
      flashErr(messageText('marketUi.feedback.noMarketEntryForUpdate'));
      return;
    }
    await selectEntry(item.marketEntryId);
    const entry = useMarketStore.getState().selectedEntry;
    if (!entry) {
      flashErr(externalOrMessage(
        useMarketStore.getState().error,
        'marketUi.feedback.updateInfoFailed',
      ));
      return;
    }
    openInstall(entry, item);
  };

  const probeInstalled = async (item: MarketInstalledItem) => {
    const result = await manage(item.id, 'probe', undefined, item.workspace);
    if (!result) {
      const error = externalOrMessage(
        useMarketStore.getState().error,
        'marketUi.feedback.probeFailed',
      );
      setProbeReceipts((current) => ({
        ...current,
        [item.id]: { status: 'failed', checkedAt: Date.now(), error },
      }));
      flashErr(error);
      return;
    }
    setProbeReceipts((current) => ({
      ...current,
      [item.id]: {
        status: 'passed',
        checkedAt: Date.now(),
        toolCount: result.toolCount,
        protocolVersion: result.protocolVersion,
      },
    }));
    flashOk(messageText('marketUi.feedback.probePassed', {
      name: rawText(item.name),
      count: result.toolCount ?? 0,
    }));
  };

  /** 启停/卸载会让某条记录消失（例如取消项目级停用），保持详情停在同一个能力上 */
  const keepDetailOpen = (anchor: MarketInstalledItem | null) => {
    if (!anchor || useMarketStore.getState().selectedInstalled) return;
    const candidates = useMarketStore.getState().installedItems.filter((candidate) => (
      candidate.kind === anchor.kind && candidate.name === anchor.name
    ));
    const fallback = candidates.find((candidate) => candidate.id === anchor.id)
      ?? candidates.find((candidate) => candidate.scope === 'user')
      ?? candidates.find((candidate) => candidate.scope === 'builtin')
      ?? candidates[0];
    if (fallback) selectInstalled(fallback.id);
  };

  const toggleLocation = async (location: CapabilityLocation, enabled: boolean) => {
    const anchor = selectedInstalled;
    const workspace = location.place === 'project' ? location.workspace : undefined;
    const result = await manage(
      location.record.id,
      enabled ? 'enable' : 'disable',
      undefined,
      workspace,
    );
    if (!result) {
      flashErr(externalOrMessage(useMarketStore.getState().error, 'marketUi.feedback.operationFailed'));
      return;
    }
    keepDetailOpen(anchor);
    setLocationEpoch((epoch) => epoch + 1);
    flashOk(workspace
      ? messageText(enabled
          ? 'marketUi.feedback.enabledAtProject'
          : 'marketUi.feedback.disabledAtProject', {
          name: rawText(location.record.name),
          project: rawText(location.label),
        })
      : messageText(enabled
          ? 'marketUi.feedback.enabledGlobally'
          : 'marketUi.feedback.disabledGlobally', {
          name: rawText(location.record.name),
        }));
  };

  const removeLocation = (location: CapabilityLocation) => {
    const item = location.record;
    const place = location.place === 'project'
      ? messageText('marketUi.feedback.projectLocation', { project: rawText(location.label) })
      : messageText('marketUi.feedback.globalLocation');
    setConfirmAsk({
      title: messageText('marketUi.feedback.uninstallNamedFrom', {
        place,
        name: rawText(item.name),
      }),
      body: item.kind === 'plugin'
        ? messageText('marketUi.feedback.uninstallPluginBody', {
            skills: item.members?.skills.length ?? 0,
            servers: item.members?.mcpServers.length ?? 0,
          })
        : messageText('marketUi.feedback.uninstallBody', { place }),
      okText: messageText('marketUi.feedback.uninstallAction'),
      danger: true,
      onOk: async () => {
        const anchor = selectedInstalled;
        const result = await manage(item.id, 'remove');
        if (!result) {
          flashErr(externalOrMessage(
            useMarketStore.getState().error,
            'marketUi.feedback.uninstallFailed',
          ));
          return;
        }
        keepDetailOpen(anchor);
        setLocationEpoch((epoch) => epoch + 1);
        flashOk(messageText('marketUi.feedback.uninstalledNamedFrom', {
          place,
          name: rawText(item.name),
        }));
      },
    });
  };

  /** 当前项目继承全局配置时，复制为独立项目配置并直接打开编辑。 */
  const forkMcpToProject = async (location: CapabilityLocation) => {
    const workspace = location.workspace;
    const item = location.record;
    if (!workspace || item.kind !== 'mcp') return;
    setConfiguringItemId(item.id);
    try {
      const current = await window.piskie.capabilities.mcp.get(item.name, { workspace });
      await window.piskie.capabilities.mcp.add({
        name: item.name,
        scope: 'project',
        workspace,
        config: structuredClone(current.config),
        force: true,
      });
      const listed = await window.piskie.capabilities.mcp.list({ scope: 'project', workspace });
      const target = listed.find((server) => server.name === item.name && server.origin === 'explicit');
      await Promise.all([
        fetchInstalled({ offset: installedOffset, updatesOnly: activeView === 'updates' }),
        fetchCatalog({ offset: catalogOffset }),
      ]);
      setLocationEpoch((epoch) => epoch + 1);
      flashOk(messageText('marketUi.feedback.projectConfigCreated', {
        project: rawText(location.label),
      }));
      if (target) {
        setEditingMcpRegistryName(undefined);
        setEditingMcpLocationKey(location.key);
        setEditingMcp(target);
      }
    } catch (forkError) {
      flashErr(rawText(forkError instanceof Error ? forkError.message : String(forkError)));
    } finally {
      setConfiguringItemId(null);
    }
  };

  const installElsewhere = async (item: MarketInstalledItem) => {
    if (!item.marketEntryId) return;
    await selectEntry(item.marketEntryId);
    const entry = useMarketStore.getState().selectedEntry;
    if (!entry) {
      flashErr(externalOrMessage(
        useMarketStore.getState().error,
        'marketUi.feedback.marketEntryFailed',
      ));
      return;
    }
    openInstall(entry);
  };

  const handleAddSource = async (input: Parameters<typeof addSource>[0]) => {
    setSourceBusy(true);
    try {
      const added = await addSource(input);
      if (added) {
        flashOk(messageText('marketUi.feedback.sourceAdded', { name: rawText(input.name) }));
      } else {
        flashErr(externalOrMessage(
          useMarketStore.getState().error,
          'marketUi.feedback.sourceAddFailed',
        ));
      }
      return added;
    } finally {
      setSourceBusy(false);
    }
  };

  const confirmRemoveSource = (source: MarketSource) => {
    setConfirmAsk({
      title: messageText('marketUi.feedback.removeSourceNamed', { name: rawText(source.name) }),
      body: messageText('marketUi.feedback.removeSourceBody'),
      okText: messageText('marketUi.feedback.removeSourceAction'),
      danger: true,
      onOk: async () => {
        const removed = await removeSource(source.id);
        if (removed) {
          flashOk(messageText('marketUi.feedback.sourceRemoved', { name: rawText(source.name) }));
        } else {
          flashErr(externalOrMessage(
            useMarketStore.getState().error,
            'marketUi.feedback.sourceRemoveFailed',
          ));
        }
      },
    });
  };

  const changeView = (view: MarketView) => {
    setActiveView(view);
    listViewportRef.current?.scrollTo({ top: 0 });
  };

  const clearFilters = () => {
    setSearchValue('');
    setQuery('');
    setKinds([]);
    setSourceIds([]);
    setInstalledScopes([]);
    setInstalledWorkspace(undefined);
  };

  const loadPage = (direction: -1 | 1) => {
    const currentOffset = activeView === 'marketplace' ? catalogOffset : installedOffset;
    const nextOffset = Math.max(0, currentOffset + (direction * MARKET_PAGE_SIZE));
    listViewportRef.current?.scrollTo({ top: 0 });
    if (activeView === 'marketplace') {
      void fetchCatalog({ offset: nextOffset });
    } else {
      void fetchInstalled({ offset: nextOffset, updatesOnly: activeView === 'updates' });
    }
  };

  const activeKind = kinds.length === 1 ? kinds[0] : 'all';
  const kindOptions: Array<{ value: MarketEntryKind | 'all'; label: string }> = [
    { value: 'all', label: t('marketUi.filters.allKinds') },
    { value: 'skill', label: t('marketUi.filters.skills') },
    { value: 'mcp', label: 'MCP' },
    { value: 'plugin', label: t('marketUi.filters.plugins') },
  ];
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const showingMarketplace = activeView === 'marketplace';
  const loading = showingMarketplace ? catalogLoading : installedLoading;
  const viewInitialized = showingMarketplace ? catalogInitialized : installedInitialized;
  // 从市场点开一个已安装的能力时，拿它在各处的安装记录当详情主体
  const detailInstalled = showingMarketplace
    ? locationRecords.find((record) => record.scope === 'user') ?? locationRecords[0] ?? null
    : selectedInstalled;
  const detailEntry = showingMarketplace
    ? selectedEntry
    : detailEntryFetch?.key === marketEntryKey ? detailEntryFetch.entry : null;
  const detailWorkspace = installedWorkspace ?? requestedWorkspace;
  const locations = detailInstalled
      ? capabilityLocations({
        records: locationRecords,
        projects,
        focusWorkspace: detailWorkspace,
        translate: t,
      })
    : [];
  const selectedProject = projects.find((project) => project.workspace === installedWorkspace);
  const selectedProjectLabel = selectedProject
    ? projectDisplayName(selectedProject)
    : t('marketUi.mcpLive.currentProject');
  const visibleCount = showingMarketplace ? entries.length : installedItems.length;
  const visibleTotal = showingMarketplace ? total : installedTotal;
  const visibleOffset = showingMarketplace ? catalogOffset : installedOffset;
  const pagination = marketPagination(visibleTotal, visibleOffset, visibleCount);
  const catalogNotice = marketCatalogNotice(stale, warnings, t);
  const failedCatalogSource = catalogSync.sources.find((source) => source.status === 'failed');
  const catalogHasFailure = Boolean(catalogError || failedCatalogSource || warnings.length > 0);
  const catalogPreparingRefresh = catalogInitialized
    && stale
    && catalogCount === 0
    && !refreshing
    && !catalogHasFailure;
  const catalogSurface = marketCatalogSurface({
    initialized: catalogInitialized,
    loading: catalogLoading || catalogPreparingRefresh,
    refreshing,
    visibleCount: entries.length,
    catalogCount,
    hasFailure: catalogHasFailure,
  });
  const activeListError = showingMarketplace ? catalogError : installedError;
  const catalogCountPending = !catalogInitialized
    || catalogPreparingRefresh
    || (refreshing && catalogCount === 0);
  const installedCountPending = !installedInitialized;
  const visibleTotalKnown = showingMarketplace
    ? catalogInitialized
      && !(catalogLoading && entries.length === 0)
      && !catalogPreparingRefresh
      && !(refreshing && catalogCount === 0)
    : installedInitialized;
  const detailBusy = showingMarketplace
    ? installingEntryId === selectedEntry?.id
    : managingItemId === selectedInstalled?.id
      || installingEntryId === selectedInstalled?.marketEntryId
      || configuringItemId === selectedInstalled?.id;
  const hasFilters = Boolean(query)
    || kinds.length > 0
    || (showingMarketplace ? sourceIds.length > 0 : installedScopes.length > 0);

  const resultLabel = showingMarketplace
    ? t('marketUi.page.catalogResults')
    : activeView === 'updates'
      ? t('marketUi.page.updateResults')
      : selectedProject
        ? t('marketUi.page.projectResults', { project: selectedProjectLabel })
        : t('marketUi.page.installedResults');

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <nav className={styles.viewTabs} aria-label={t('marketUi.page.viewsAria')}>
          <button
            type="button"
            className={`${styles.viewTab} ${activeView === 'marketplace' ? styles.viewTabActive : ''}`}
            aria-pressed={activeView === 'marketplace'}
            onClick={() => changeView('marketplace')}
          >
            {t('marketUi.page.marketTab')}
            <span className={styles.viewCount}>{catalogCountPending ? '…' : catalogCount}</span>
          </button>
          <button
            type="button"
            className={`${styles.viewTab} ${activeView === 'installed' ? styles.viewTabActive : ''}`}
            aria-pressed={activeView === 'installed'}
            onClick={() => changeView('installed')}
          >
            {t('marketUi.page.installedTab')}
            <span className={styles.viewCount}>{installedCountPending ? '…' : installedCount}</span>
          </button>
          <button
            type="button"
            className={`${styles.viewTab} ${activeView === 'updates' ? styles.viewTabActive : ''}`}
            aria-pressed={activeView === 'updates'}
            onClick={() => changeView('updates')}
          >
            {t('marketUi.page.updatesTab')}
            <span className={`${styles.viewCount} ${updateCount > 0 ? styles.viewCountAlert : ''}`}>
              {installedCountPending ? '…' : updateCount}
            </span>
          </button>
        </nav>

        <div className={styles.toolbarRight}>
          <label className={styles.searchBox}>
            <Search aria-hidden />
            <input
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder={showingMarketplace
                ? t('marketUi.page.searchCatalog')
                : t('marketUi.page.searchInstalled')}
              aria-label={t('marketUi.page.searchAria')}
            />
            {loading && <LoaderCircle className={styles.spin} aria-hidden />}
          </label>
          {showingMarketplace && (
            <SourceFilter
              sources={sources}
              selected={sourceIds}
              onChange={setSourceIds}
              onManage={() => setSourceManagerOpen(true)}
            />
          )}
          <button
            type="button"
            className={styles.toolButton}
            disabled={refreshing}
            onClick={() => void refreshCatalog()}
          >
            <RefreshCw className={refreshing ? styles.spin : undefined} aria-hidden />
            <span>
              {refreshing ? t('marketUi.page.refreshing') : t('marketUi.page.refreshCatalog')}
            </span>
          </button>
        </div>
      </div>

      <div className={styles.body}>
        <aside className={styles.listPane} aria-label={t('marketUi.page.capabilityListAria')}>
          <div className={styles.filterRow} role="group" aria-label={t('marketUi.filters.kindAria')}>
            <span className={styles.filterLabel}>{t('marketUi.filters.kindLabel')}</span>
            {kindOptions.map((option) => (
              <button
                type="button"
                key={option.value}
                className={`${styles.filterChip} ${activeKind === option.value ? styles.filterChipActive : ''}`}
                aria-pressed={activeKind === option.value}
                onClick={() => setKinds(option.value === 'all' ? [] : [option.value])}
              >
                {option.label}
              </button>
            ))}
          </div>

          {!showingMarketplace && (
            <InstalledContextBar
              scopes={installedScopes}
              workspace={installedWorkspace}
              projects={projects}
              onScopesChange={setInstalledScopes}
              onWorkspaceChange={setInstalledWorkspace}
            />
          )}

          <div className={styles.resultLine}>
            <span>{resultLabel}</span>
            <span>
              {visibleTotalKnown
                ? t('marketUi.page.itemCount', { count: visibleTotal.toLocaleString(locale) })
                : t('marketUi.page.unknownItemCount')}
            </span>
          </div>

          <div
            ref={listViewportRef}
            className={`${styles.listViewport} ${loading && visibleCount > 0 ? styles.listLoading : ''}`}
            aria-busy={loading || (showingMarketplace && refreshing)}
          >
            {showingMarketplace && catalogNotice && catalogSurface === 'content' && (
              <div className={styles.notice}>
                <AlertTriangle aria-hidden />
                <span>{catalogNotice}</span>
              </div>
            )}
            {activeListError && (!showingMarketplace || catalogSurface !== 'failure') && (
              <div className={`${styles.notice} ${styles.noticeError}`}>
                <AlertTriangle aria-hidden /><span>{activeListError}</span>
              </div>
            )}

            {showingMarketplace && catalogSurface !== 'content' && catalogSurface !== 'empty' && (
              <CatalogSyncHint
                sync={catalogSync}
                reading={catalogSurface === 'loading'}
                failed={catalogSurface === 'failure'}
                message={catalogError || failedCatalogSource?.error || warnings[0]}
                onRetry={() => void refreshCatalog()}
              />
            )}

            {showingMarketplace
              ? entries.map((entry) => (
                  <CapabilityListItem
                    key={entry.id}
                    entry={entry}
                    selected={selectedEntry?.id === entry.id}
                    busy={installingEntryId === entry.id}
                    onSelect={(selected) => void selectEntry(selected.id)}
                    onInstall={(selected) => openInstall(selected)}
                    onManage={(selected) => void openInstalledForEntry(selected)}
                  />
                ))
              : installedItems.map((item) => (
                  <InstalledListItem
                    key={item.id}
                    item={item}
                    selected={selectedInstalled?.id === item.id}
                    busy={managingItemId === item.id || installingEntryId === item.marketEntryId}
                    onSelect={(selected) => selectInstalled(selected.id)}
                    onUpdate={(selected) => void updateInstalled(selected)}
                    projectLabel={(() => {
                      const workspace = item.workspace;
                      const project = projects.find((candidate) => candidate.workspace === workspace);
                      return project ? projectDisplayName(project) : undefined;
                    })()}
                  />
                ))}

            {((showingMarketplace && catalogSurface === 'empty') || (
              !showingMarketplace
              && viewInitialized
              && !loading
              && !activeListError
              && visibleCount === 0
            )) && (
              <div className={styles.emptyList}>
                {hasFilters ? <Search aria-hidden /> : <PackageOpen aria-hidden />}
                <strong>
                  {activeView === 'updates'
                    ? t('marketUi.empty.allUpToDate')
                    : hasFilters
                      ? t('marketUi.empty.noMatches')
                      : showingMarketplace
                        ? t('marketUi.empty.catalogEmpty')
                        : t('marketUi.empty.noneInstalled')}
                </strong>
                <span>
                  {activeView === 'updates'
                    ? t('marketUi.empty.updatesHint')
                    : hasFilters
                      ? t('marketUi.empty.filtersHint')
                      : showingMarketplace
                        ? t('marketUi.empty.catalogHint')
                        : t('marketUi.empty.installedHint')}
                </span>
                {hasFilters && activeView !== 'updates' && (
                  <button type="button" className={styles.emptyListAction} onClick={clearFilters}>
                    {t('marketUi.empty.clearFilters')}
                  </button>
                )}
                {!hasFilters && !showingMarketplace && activeView !== 'updates' && (
                  <button type="button" className={styles.emptyListAction} onClick={() => changeView('marketplace')}>
                    {t('marketUi.empty.browseMarket')}
                  </button>
                )}
              </div>
            )}
            {!showingMarketplace && (!viewInitialized || loading) && visibleCount === 0 && (
              <div className={styles.emptyList}>
                <LoaderCircle className={styles.spin} aria-hidden />
                <strong>{t('marketUi.empty.loadingInstalled')}</strong>
              </div>
            )}
          </div>

          {pagination.pageCount > 1 && (
            <footer className={styles.pagination} aria-label={t('marketUi.pagination.aria')}>
              <button
                type="button"
                className={styles.pageButton}
                disabled={loading || !pagination.canPrevious}
                onClick={() => loadPage(-1)}
                aria-label={t('marketUi.pagination.previous')}
              >
                <ChevronLeft aria-hidden />
              </button>
              <span>
                {t('marketUi.pagination.summary', {
                  start: pagination.rangeStart,
                  end: pagination.rangeEnd,
                  total: visibleTotal.toLocaleString(locale),
                  page: pagination.pageNumber,
                  pages: pagination.pageCount,
                })}
              </span>
              <button
                type="button"
                className={styles.pageButton}
                disabled={loading || !pagination.canNext}
                onClick={() => loadPage(1)}
                aria-label={t('marketUi.pagination.next')}
              >
                <ChevronRight aria-hidden />
              </button>
            </footer>
          )}
        </aside>

        <CapabilityDetailPane
          entry={detailEntry}
          installed={detailInstalled}
          locations={locations}
          locationsLoading={locationsLoading}
          stats={{ market: catalogCount, installed: installedCount, updates: updateCount }}
          busy={detailBusy}
          onInstall={(entry) => openInstall(entry)}
          onProbe={(item) => void probeInstalled(item)}
          onUpdate={(item) => void updateInstalled(item)}
          onManageOwner={(item) => void openPluginOwner(item)}
          onConfigureMcp={(location) => void configureMcp(location)}
          mcpEditor={editingMcp && editingMcpLocationKey
            ? { locationKey: editingMcpLocationKey, server: editingMcp, registryName: editingMcpRegistryName }
            : null}
          savingMcp={savingMcp}
          onSaveMcpConfig={saveMcpConfig}
          onCancelMcpEdit={closeMcpEditor}
          onToggleLocation={(location, enabled) => void toggleLocation(location, enabled)}
          onRemoveLocation={removeLocation}
          onForkLocation={(location) => void forkMcpToProject(location)}
          onInstallElsewhere={(item) => void installElsewhere(item)}
          onSelectMember={(item, member) => void openPluginMember(item, member)}
          onNavigateView={changeView}
          projectLabel={selectedProject ? projectDisplayName(selectedProject) : undefined}
          projects={projects}
          mcpProbe={detailInstalled ? probeReceipts[detailInstalled.id] : undefined}
          focusWorkspace={detailWorkspace}
          onFlash={flashOk}
        />
      </div>

      <div ref={flashDockRef} popover="manual" className={styles.flashDock}>
        {flash && (
          <div className={styles.flash} data-tone={flash.tone} role="status">
            <span className={styles.flashText} title={present(flash.text)}>{present(flash.text)}</span>
            <button
              type="button"
              className={styles.flashClose}
              aria-label={t('marketUi.feedback.closeNotice')}
              onClick={() => setFlash(null)}
            >
              <X aria-hidden />
            </button>
          </div>
        )}
      </div>

      <dialog ref={confirmRef} className={styles.confirmDialog} onClose={() => setConfirmAsk(null)}>
        {confirmAsk && (
          <div className={styles.dialogSheet}>
            <header className={styles.dialogHeader}>
              <h2>{present(confirmAsk.title)}</h2>
            </header>
            <p className={styles.confirmBody}>{present(confirmAsk.body)}</p>
            <div className={styles.confirmFoot}>
              {confirmAsk.onOk && (
                <button type="button" className={styles.secondaryButton} onClick={() => setConfirmAsk(null)}>
                  {t('marketUi.feedback.cancelAction')}
                </button>
              )}
              <button
                type="button"
                className={confirmAsk.danger ? styles.dangerButton : styles.primaryButton}
                onClick={() => {
                  const ask = confirmAsk;
                  setConfirmAsk(null);
                  if (!ask.onOk) return;
                  void (async () => {
                    try {
                      await ask.onOk!();
                    } catch (error) {
                      flashErr(rawText(error instanceof Error ? error.message : String(error)));
                    }
                  })();
                }}
              >
                {present(confirmAsk.okText)}
              </button>
            </div>
          </div>
        )}
      </dialog>

      <InstallScopeDialog
        key={`${installEntry?.id ?? 'closed'}:${installTarget?.id ?? 'new'}`}
        entry={installEntry}
        initialTarget={installTarget}
        projects={projects}
        installing={installingEntryId === installEntry?.id}
        onClose={closeInstall}
        onConfirm={(request) => void handleInstall(request)}
      />
      <SourceManagerDialog
        open={sourceManagerOpen}
        sources={sources}
        busy={sourceBusy}
        onClose={() => setSourceManagerOpen(false)}
        onAdd={handleAddSource}
        onRemove={confirmRemoveSource}
      />
    </div>
  );
};

export default Market;
