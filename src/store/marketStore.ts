import { create } from 'zustand';

import type {
  MarketCatalogSyncProgress,
  MarketCatalogPage,
  MarketChangeEvent,
  MarketEntry,
  MarketEntryKind,
  MarketInstalledItem,
  MarketInstalledScope,
  MarketInstallRequest,
  MarketInstallResult,
  MarketManageAction,
  MarketManageResult,
  MarketProjectOption,
  MarketSource,
} from '@shared/types/market';

export type CatalogSourceSyncStatus = 'pending' | 'syncing' | 'ready' | 'failed';

export interface CatalogSourceSyncState {
  id: string;
  name: string;
  status: CatalogSourceSyncStatus;
  error?: string;
}

export interface CatalogSyncState {
  active: boolean;
  completed: number;
  total: number;
  sources: CatalogSourceSyncState[];
}

interface MarketState {
  entries: MarketEntry[];
  installedItems: MarketInstalledItem[];
  sources: MarketSource[];
  projects: MarketProjectOption[];
  selectedEntry: MarketEntry | null;
  selectedInstalled: MarketInstalledItem | null;
  query: string;
  kinds: MarketEntryKind[];
  sourceIds: string[];
  installedScopes: MarketInstalledScope[];
  /** 只在筛「项目」时有意义：限定看哪个项目里的副本 */
  installedWorkspace?: string;
  catalogCount: number;
  total: number;
  catalogOffset: number;
  installedTotal: number;
  installedCount: number;
  installedOffset: number;
  installedUpdatesOnly: boolean;
  updateCount: number;
  stale: boolean;
  warnings: string[];
  catalogLoading: boolean;
  installedLoading: boolean;
  catalogInitialized: boolean;
  installedInitialized: boolean;
  refreshing: boolean;
  catalogSync: CatalogSyncState;
  installingEntryId: string | null;
  managingItemId: string | null;
  catalogError: string | null;
  installedError: string | null;
  error: string | null;
  initializeCatalog: () => Promise<void>;
  fetchCatalog: (
    options?: { append?: boolean; offset?: number; refreshIfStale?: boolean },
  ) => Promise<MarketCatalogPage | null>;
  fetchInstalled: (options?: { append?: boolean; offset?: number; updatesOnly?: boolean }) => Promise<void>;
  refreshCatalog: () => Promise<void>;
  setQuery: (query: string) => void;
  setKinds: (kinds: MarketEntryKind[]) => void;
  setSourceIds: (sourceIds: string[]) => void;
  setInstalledScopes: (scopes: MarketInstalledScope[]) => void;
  setInstalledWorkspace: (workspace?: string) => void;
  selectEntry: (entryId: string | null) => Promise<void>;
  selectInstalled: (itemId: string | null) => void;
  install: (request: MarketInstallRequest) => Promise<MarketInstallResult | null>;
  manage: (
    itemId: string,
    action: MarketManageAction,
    purge?: boolean,
    workspace?: string,
  ) => Promise<MarketManageResult | null>;
  fetchProjects: () => Promise<void>;
  addSource: (input: { name: string; kind: MarketSource['kind']; url: string; ref?: string }) => Promise<boolean>;
  removeSource: (sourceId: string) => Promise<boolean>;
  applyCatalogSyncProgress: (progress: MarketCatalogSyncProgress) => void;
}

let catalogRequestsInFlight = 0;
let installedRequestsInFlight = 0;

export const useMarketStore = create<MarketState>((set, get) => ({
  entries: [],
  installedItems: [],
  sources: [],
  projects: [],
  selectedEntry: null,
  selectedInstalled: null,
  query: '',
  kinds: [],
  sourceIds: [],
  installedScopes: [],
  installedWorkspace: undefined,
  catalogCount: 0,
  total: 0,
  catalogOffset: 0,
  installedTotal: 0,
  installedCount: 0,
  installedOffset: 0,
  installedUpdatesOnly: false,
  updateCount: 0,
  stale: false,
  warnings: [],
  catalogLoading: false,
  installedLoading: false,
  catalogInitialized: false,
  installedInitialized: false,
  refreshing: false,
  catalogSync: {
    active: false,
    completed: 0,
    total: 0,
    sources: [],
  },
  installingEntryId: null,
  managingItemId: null,
  catalogError: null,
  installedError: null,
  error: null,

  initializeCatalog: async () => {
    const page = await get().fetchCatalog({ offset: 0 });
    if (page?.stale) await get().refreshCatalog();
  },

  fetchCatalog: async (options = {}) => {
    const state = get();
    catalogRequestsInFlight += 1;
    set({
      catalogLoading: true,
      catalogError: null,
    });
    try {
      const page = await window.piskie.capabilities.market.list({
        query: state.query || undefined,
        kinds: state.kinds.length > 0 ? state.kinds : undefined,
        sourceIds: state.sourceIds.length > 0 ? state.sourceIds : undefined,
        offset: options.offset ?? (options.append ? state.entries.length : 0),
        limit: 40,
        refreshIfStale: options.refreshIfStale,
      });
      set({
        entries: options.append ? [...state.entries, ...page.entries] : page.entries,
        sources: page.sources,
        catalogCount: page.catalogCount,
        total: page.total,
        catalogOffset: page.offset,
        stale: page.stale,
        warnings: page.warnings,
        selectedEntry: get().selectedEntry
          ? page.entries.find((entry) => entry.id === get().selectedEntry?.id) ?? null
          : null,
        catalogInitialized: true,
      });
      return page;
    } catch (error) {
      set({
        catalogError: error instanceof Error ? error.message : String(error),
        catalogInitialized: true,
      });
      return null;
    } finally {
      catalogRequestsInFlight = Math.max(0, catalogRequestsInFlight - 1);
      set({ catalogLoading: catalogRequestsInFlight > 0 });
    }
  },

  fetchInstalled: async (options = {}) => {
    const state = get();
    const updatesOnly = options.updatesOnly ?? state.installedUpdatesOnly;
    installedRequestsInFlight += 1;
    set({ installedLoading: true, installedError: null });
    try {
      const page = await window.piskie.capabilities.market.installed({
        query: state.query || undefined,
        kinds: state.kinds.length > 0 ? state.kinds : undefined,
        scopes: state.installedScopes.length > 0 ? state.installedScopes : undefined,
        workspace: state.installedWorkspace,
        updatesOnly,
        offset: options.offset ?? (options.append ? state.installedItems.length : 0),
        limit: 40,
      });
      set({
        installedItems: options.append ? [...state.installedItems, ...page.items] : page.items,
        installedCount: page.installedCount,
        installedTotal: page.total,
        installedOffset: page.offset,
        installedUpdatesOnly: updatesOnly,
        updateCount: page.updateCount,
        selectedInstalled: get().selectedInstalled
          ? page.items.find((item) => item.id === get().selectedInstalled?.id) ?? null
          : null,
        installedInitialized: true,
      });
    } catch (error) {
      set({
        installedError: error instanceof Error ? error.message : String(error),
        installedInitialized: true,
      });
    } finally {
      installedRequestsInFlight = Math.max(0, installedRequestsInFlight - 1);
      set({ installedLoading: installedRequestsInFlight > 0 });
    }
  },

  refreshCatalog: async () => {
    const state = get();
    const selectedSources = state.sources.filter((source) => (
      source.enabled && (state.sourceIds.length === 0 || state.sourceIds.includes(source.id))
    ));
    set({
      refreshing: true,
      catalogError: null,
      catalogSync: {
        active: true,
        completed: 0,
        total: selectedSources.length,
        sources: selectedSources.map((source) => ({
          id: source.id,
          name: source.name,
          status: 'pending',
        })),
      },
    });
    try {
      const response = await window.piskie.capabilities.market.refresh(
        get().sourceIds.length > 0 ? get().sourceIds : undefined,
      );
      await get().fetchCatalog();
      const current = get();
      const returnedSources = new Map(response.sources.map((source) => [source.id, source]));
      const syncSources = current.catalogSync.sources.map((source) => {
        const returned = returnedSources.get(source.id);
        const failed = source.status === 'failed' || Boolean(returned?.error);
        return {
          ...source,
          status: failed ? 'failed' as const : 'ready' as const,
          error: source.error ?? returned?.error,
        };
      });
      set({
        sources: current.sources.map((source) => ({
          ...source,
          error: returnedSources.get(source.id)?.error,
        })),
        warnings: [...new Set([...current.warnings, ...response.warnings])],
        refreshing: false,
        catalogSync: {
          active: false,
          completed: syncSources.length,
          total: current.catalogSync.total || syncSources.length,
          sources: syncSources,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((current) => ({
        catalogError: message,
        refreshing: false,
        catalogSync: {
          ...current.catalogSync,
          active: false,
          sources: current.catalogSync.sources.map((source) => (
            source.status === 'ready' || source.status === 'failed'
              ? source
              : { ...source, status: 'failed', error: message }
          )),
        },
      }));
    }
  },

  setQuery: (query) => set({ query }),
  setKinds: (kinds) => set({ kinds }),
  setSourceIds: (sourceIds) => set({ sourceIds }),
  setInstalledScopes: (installedScopes) => set({ installedScopes, installedOffset: 0, selectedInstalled: null }),
  setInstalledWorkspace: (installedWorkspace) => set({
    installedWorkspace,
    installedOffset: 0,
    selectedInstalled: null,
  }),

  selectEntry: async (entryId) => {
    if (!entryId) {
      set({ selectedEntry: null });
      return;
    }
    const fallback = get().entries.find((entry) => entry.id === entryId) ?? null;
    set({ selectedEntry: fallback });
    try {
      set({ selectedEntry: await window.piskie.capabilities.market.detail(entryId) });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  selectInstalled: (itemId) => set({
    selectedInstalled: itemId
      ? get().installedItems.find((item) => item.id === itemId) ?? null
      : null,
  }),

  install: async (request) => {
    set({ installingEntryId: request.entryId, error: null });
    try {
      const result = await window.piskie.capabilities.market.install(request);
      set({ installingEntryId: null });
      const state = get();
      await Promise.all([
        state.fetchCatalog({ offset: state.catalogOffset }),
        state.fetchInstalled({
          offset: state.installedOffset,
          updatesOnly: state.installedUpdatesOnly,
        }),
      ]);
      return result;
    } catch (error) {
      set({
        installingEntryId: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },

  manage: async (itemId, action, purge, workspace) => {
    set({ managingItemId: itemId, error: null });
    try {
      const result = await window.piskie.capabilities.market.manage({ itemId, action, purge, workspace });
      set({ managingItemId: null });
      if (action !== 'probe') {
        const state = get();
        await Promise.all([
          state.fetchInstalled({
            offset: state.installedOffset,
            updatesOnly: state.installedUpdatesOnly,
          }),
          state.fetchCatalog({ offset: state.catalogOffset }),
        ]);
      }
      return result;
    } catch (error) {
      set({
        managingItemId: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },

  fetchProjects: async () => {
    try {
      set({ projects: await window.piskie.capabilities.market.projects() });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  addSource: async (input) => {
    try {
      await window.piskie.capabilities.market.addSource(input);
      await get().fetchCatalog();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  removeSource: async (sourceId) => {
    try {
      await window.piskie.capabilities.market.removeSource(sourceId);
      set({ sourceIds: get().sourceIds.filter((id) => id !== sourceId) });
      await get().fetchCatalog();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  applyCatalogSyncProgress: (progress) => {
    set((state) => {
      let sources = state.catalogSync.sources;
      if (progress.phase === 'started' && sources.length === 0) {
        sources = state.sources
          .filter((source) => source.enabled)
          .map((source) => ({ id: source.id, name: source.name, status: 'pending' as const }));
      }
      if (progress.sourceId && progress.sourceName) {
        const status: CatalogSourceSyncStatus = progress.phase === 'source-started'
          ? 'syncing'
          : progress.phase === 'source-ready'
            ? 'ready'
            : progress.phase === 'source-failed'
              ? 'failed'
              : 'pending';
        const nextSource: CatalogSourceSyncState = {
          id: progress.sourceId,
          name: progress.sourceName,
          status,
          error: progress.error,
        };
        sources = sources.some((source) => source.id === progress.sourceId)
          ? sources.map((source) => source.id === progress.sourceId ? nextSource : source)
          : [...sources, nextSource];
      }
      return {
        refreshing: true,
        catalogSync: {
          active: true,
          completed: progress.completed,
          total: progress.total,
          sources,
        },
      };
    });
  },
}));

/** CLI、Browser Skill 发布或其他窗口改变能力状态后，按当前分页/筛选重新投影市场。 */
export function subscribeToMarketChanges(debounceMs = 80): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloadInstalled = false;
  let finishCatalogSync = false;
  const scheduleReload = (includeInstalled: boolean, finishSync: boolean): void => {
    reloadInstalled ||= includeInstalled;
    finishCatalogSync ||= finishSync;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const state = useMarketStore.getState();
      const shouldReloadInstalled = reloadInstalled;
      const shouldFinishSync = finishCatalogSync;
      reloadInstalled = false;
      finishCatalogSync = false;
      const tasks: Promise<unknown>[] = [state.fetchCatalog({ offset: state.catalogOffset })];
      if (shouldReloadInstalled) {
        tasks.push(state.fetchInstalled({
          offset: state.installedOffset,
          updatesOnly: state.installedUpdatesOnly,
        }));
      }
      void Promise.all(tasks).finally(() => {
        if (!shouldFinishSync) return;
        useMarketStore.setState((current) => ({
          refreshing: false,
          catalogSync: { ...current.catalogSync, active: false },
        }));
      });
    }, debounceMs);
  };
  const unsubscribe = window.piskie.capabilities.market.observeChanges((event: MarketChangeEvent) => {
    if (event.kind === 'catalog' && event.sync) {
      useMarketStore.getState().applyCatalogSyncProgress(event.sync);
      if (event.sync.phase === 'source-ready') scheduleReload(false, false);
      return;
    }
    if (event.kind === 'catalog') {
      scheduleReload(false, event.type === 'refreshed');
      return;
    }
    scheduleReload(true, false);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
