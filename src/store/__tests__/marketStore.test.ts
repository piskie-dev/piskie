import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  MarketChangeEvent,
  MarketEntry,
  MarketInstalledItem,
  MarketInstalledQuery,
  MarketListQuery,
  MarketSource,
} from '@shared/types/market';

import { subscribeToMarketChanges, useMarketStore } from '../marketStore';

const entry: MarketEntry = {
  id: 'registry:mcp:context7',
  kind: 'mcp',
  name: 'context7',
  description: 'Documentation MCP',
  sourceId: 'registry',
  sourceName: 'MCP Registry',
  sourceUrl: 'https://registry.example.test',
  installSource: 'registry:context7',
};

const installed: MarketInstalledItem = {
  id: 'mcp:user:explicit:context7',
  kind: 'mcp',
  name: 'context7',
  description: 'Documentation MCP',
  scope: 'user',
  origin: 'explicit',
  enabled: true,
  canToggle: true,
  canRemove: true,
  marketEntryId: entry.id,
  updateAvailable: true,
  availableVersion: '2.0.0',
};

const registrySource: MarketSource = {
  id: 'mcp-registry',
  name: 'MCP Registry',
  kind: 'mcp-registry',
  url: 'https://registry.example.test',
  builtin: true,
  enabled: true,
};

function createMarketApi() {
  let changeListener: ((event: MarketChangeEvent) => void) | undefined;
  return {
    list: vi.fn(async (query: MarketListQuery = {}) => ({
      entries: [entry],
      sources: [] as MarketSource[],
      catalogCount: 19428,
      total: 81,
      offset: query.offset ?? 0,
      limit: query.limit ?? 40,
      stale: false,
      warnings: [] as string[],
    })),
    installed: vi.fn(async (query: MarketInstalledQuery = {}) => ({
      items: [installed],
      installedCount: 9,
      total: query.updatesOnly ? 1 : 3,
      offset: query.offset ?? 0,
      limit: query.limit ?? 40,
      updateCount: 1,
    })),
    manage: vi.fn(async (request: { itemId: string; action: string; purge?: boolean; workspace?: string }) => ({
      itemId: request.itemId,
      action: request.action,
      protocolVersion: undefined as string | undefined,
      toolCount: undefined as number | undefined,
    })),
    detail: vi.fn(async () => entry),
    install: vi.fn(),
    refresh: vi.fn(async () => ({ sources: [] as MarketSource[], warnings: [] as string[] })),
    projects: vi.fn(),
    preview: vi.fn(),
    addSource: vi.fn(),
    removeSource: vi.fn(),
    observeChanges: vi.fn((listener: (event: MarketChangeEvent) => void) => {
      changeListener = listener;
      return vi.fn();
    }),
    emitChange: (event: MarketChangeEvent = { kind: 'skill', type: 'changed' }) => changeListener?.(event),
  };
}

beforeEach(() => {
  useMarketStore.setState({
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
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('marketStore pagination and management', () => {
  it('keeps catalog loading while the faster installed request finishes', async () => {
    const market = createMarketApi();
    const listCatalog = market.list.getMockImplementation();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    market.list.mockImplementationOnce(async (query) => {
      await gate;
      return listCatalog!(query);
    });
    vi.stubGlobal('window', { piskie: { capabilities: { market } } });

    const catalogPending = useMarketStore.getState().fetchCatalog();
    const installedPending = useMarketStore.getState().fetchInstalled();
    await installedPending;

    expect(useMarketStore.getState()).toMatchObject({
      catalogLoading: true,
      installedLoading: false,
      catalogInitialized: false,
      installedInitialized: true,
    });

    release();
    await catalogPending;

    expect(useMarketStore.getState()).toMatchObject({
      catalogLoading: false,
      catalogInitialized: true,
    });
  });

  it('shows a cached catalog before a stale source refresh settles', async () => {
    const market = createMarketApi();
    const listCatalog = market.list.getMockImplementation();
    market.list.mockImplementation(async (query) => {
      const response = await listCatalog!(query);
      return {
        ...response,
        entries: [entry],
        sources: [registrySource],
        stale: true,
      };
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    market.refresh.mockImplementationOnce(async () => {
      await gate;
      return { sources: [registrySource], warnings: [] };
    });
    vi.stubGlobal('window', { piskie: { capabilities: { market } } });

    const pending = useMarketStore.getState().initializeCatalog();
    await vi.waitFor(() => expect(market.refresh).toHaveBeenCalledTimes(1));

    expect(useMarketStore.getState()).toMatchObject({
      entries: [entry],
      catalogInitialized: true,
      catalogLoading: false,
      refreshing: true,
    });

    release();
    await pending;
    expect(market.list).toHaveBeenCalledTimes(2);
    expect(useMarketStore.getState().refreshing).toBe(false);
  });

  it('sends explicit catalog and update-page offsets to IPC', async () => {
    const market = createMarketApi();
    vi.stubGlobal('window', { piskie: { capabilities: { market } } });
    useMarketStore.setState({
      query: 'docs',
      kinds: ['mcp'],
      sourceIds: ['registry'],
      installedScopes: ['project'],
      installedWorkspace: '/repo/docs',
    });

    await useMarketStore.getState().fetchCatalog({ offset: 40 });
    await useMarketStore.getState().fetchInstalled({ offset: 80, updatesOnly: true });

    expect(market.list).toHaveBeenCalledWith({
      query: 'docs',
      kinds: ['mcp'],
      sourceIds: ['registry'],
      offset: 40,
      limit: 40,
      refreshIfStale: undefined,
    });
    expect(market.installed).toHaveBeenCalledWith({
      query: 'docs',
      kinds: ['mcp'],
      scopes: ['project'],
      workspace: '/repo/docs',
      updatesOnly: true,
      offset: 80,
      limit: 40,
    });
    expect(useMarketStore.getState()).toMatchObject({
      catalogOffset: 40,
      installedOffset: 80,
      installedUpdatesOnly: true,
      updateCount: 1,
      catalogCount: 19428,
      installedCount: 9,
    });
  });

  it('keeps the current pages and updates-only mode after a mutation', async () => {
    const market = createMarketApi();
    vi.stubGlobal('window', { piskie: { capabilities: { market } } });
    useMarketStore.setState({
      entries: [entry],
      installedItems: [installed],
      selectedInstalled: installed,
      catalogOffset: 80,
      installedOffset: 40,
      installedUpdatesOnly: true,
    });

    await useMarketStore.getState().manage(installed.id, 'disable', undefined, '/repo/docs');

    expect(market.manage).toHaveBeenCalledWith({
      itemId: installed.id,
      action: 'disable',
      purge: undefined,
      workspace: '/repo/docs',
    });
    expect(market.installed).toHaveBeenCalledWith(expect.objectContaining({
      offset: 40,
      updatesOnly: true,
    }));
    expect(market.list).toHaveBeenCalledWith(expect.objectContaining({ offset: 80 }));
    expect(useMarketStore.getState().managingItemId).toBeNull();
  });

  it('reports a real MCP probe result without reloading either list', async () => {
    const market = createMarketApi();
    market.manage.mockResolvedValueOnce({
      itemId: installed.id,
      action: 'probe',
      protocolVersion: '2025-11-25',
      toolCount: 2,
    });
    vi.stubGlobal('window', { piskie: { capabilities: { market } } });

    const result = await useMarketStore.getState().manage(installed.id, 'probe');

    expect(result).toMatchObject({ protocolVersion: '2025-11-25', toolCount: 2 });
    expect(market.installed).not.toHaveBeenCalled();
    expect(market.list).not.toHaveBeenCalled();
  });

  it('debounces external capability changes and reloads the current pages', async () => {
    vi.useFakeTimers();
    const market = createMarketApi();
    vi.stubGlobal('window', { piskie: { capabilities: { market } } });
    useMarketStore.setState({
      catalogOffset: 80,
      installedOffset: 40,
      installedUpdatesOnly: true,
    });
    const unsubscribe = subscribeToMarketChanges(50);

    market.emitChange();
    market.emitChange();
    await vi.advanceTimersByTimeAsync(50);

    expect(market.list).toHaveBeenCalledTimes(1);
    expect(market.list).toHaveBeenCalledWith(expect.objectContaining({ offset: 80 }));
    expect(market.installed).toHaveBeenCalledTimes(1);
    expect(market.installed).toHaveBeenCalledWith(expect.objectContaining({
      offset: 40,
      updatesOnly: true,
    }));
    unsubscribe();
    vi.useRealTimers();
  });

  it('shows each ready source incrementally without reloading installed capabilities', async () => {
    vi.useFakeTimers();
    const market = createMarketApi();
    vi.stubGlobal('window', { piskie: { capabilities: { market } } });
    useMarketStore.setState({ sources: [registrySource] });
    const unsubscribe = subscribeToMarketChanges(50);

    market.emitChange({
      kind: 'catalog',
      type: 'sync-progress',
      sync: {
        phase: 'source-started',
        completed: 0,
        total: 1,
        sourceId: registrySource.id,
        sourceName: registrySource.name,
      },
    });
    expect(useMarketStore.getState().catalogSync.sources[0]).toMatchObject({
      id: registrySource.id,
      status: 'syncing',
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(market.list).not.toHaveBeenCalled();

    market.emitChange({
      kind: 'catalog',
      type: 'sync-progress',
      sync: {
        phase: 'source-ready',
        completed: 1,
        total: 1,
        sourceId: registrySource.id,
        sourceName: registrySource.name,
      },
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(market.list).toHaveBeenCalledTimes(1);
    expect(market.installed).not.toHaveBeenCalled();
    expect(useMarketStore.getState().entries).toEqual([entry]);
    expect(useMarketStore.getState().catalogSync.sources[0]?.status).toBe('ready');
    unsubscribe();
    vi.useRealTimers();
  });
});
