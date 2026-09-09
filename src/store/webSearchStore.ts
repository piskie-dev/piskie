import { create } from 'zustand';
import type { ConfigDescriptor } from '../../shared/types/config';
import type { SearchProviderConfig, SearchProviderPreset, WebSearchConfig } from '../../shared/types/web-search';
import { applyConfigFieldChanges, type ConfigFieldMutation } from '../features/config/config-transaction';
import { subscribeToConfigDomainRevisions } from '../features/config/domain-revision-sync';
import { messageText, rawText, type PresentationText } from '../i18n/presentationText';

type ProviderUpdates = Partial<SearchProviderConfig>;

interface WebSearchState {
  config: WebSearchConfig | null;
  descriptor: ConfigDescriptor | null;
  presets: SearchProviderPreset[];
  isLoading: boolean;
  isApplying: boolean;
  connecting: Record<string, boolean>;
  authorizationResults: Record<string, 'connected' | 'cancelled' | undefined>;
  error: PresentationText | null;
  refresh(): Promise<void>;
  subscribeToConfigChanges(): () => void;
  addProvider(id: string): Promise<boolean>;
  updateProvider(id: string, updates: ProviderUpdates): Promise<boolean>;
  removeProvider(id: string): Promise<boolean>;
  setDefaultProvider(id: string): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<boolean>;
  connectOAuth(id: string): Promise<void>;
  cancelOAuth(id: string): Promise<void>;
  disconnectOAuth(id: string): Promise<void>;
  waitForSaves(): Promise<void>;
  clearError(): void;
}

export const useWebSearchStore = create<WebSearchState>((set, get) => {
  let mutationTail = Promise.resolve();
  let pendingMutations = 0;
  let refreshing: Promise<void> | undefined;

  const reportError = (error: unknown) => set({ error: rawText(error instanceof Error ? error.message : String(error)) });

  const refresh = async () => {
    if (refreshing) return refreshing;
    set({ isLoading: true });
    refreshing = (async () => {
      const [config, descriptor, presets] = await Promise.all([
        window.piskie.configuration.read<WebSearchConfig>('web-search'),
        window.piskie.configuration.describe('web-search'),
        window.piskie.webSearch.listProviders(),
      ]);
      if (!get().config || config.revision >= get().config!.revision) set({ config, descriptor, presets });
    })();
    try { await refreshing; } catch (error) { reportError(error); throw error; }
    finally { refreshing = undefined; set({ isLoading: false }); }
  };

  const commit = (
    changes: (config: WebSearchConfig) => ConfigFieldMutation[], expectedRevision?: number,
  ): Promise<boolean> => {
    pendingMutations += 1;
    set({ isApplying: true, error: null });
    const task = mutationTail.then(async () => {
      try {
        if (!get().config || !get().descriptor) await refresh();
        const { config, descriptor } = get();
        const mutations = changes(config!);
        if (mutations.length === 0) return true;
        const result = await applyConfigFieldChanges('web-search', descriptor!, expectedRevision ?? config!.revision, mutations);
        await refresh();
        if (get().config!.revision < result.receipt.revision) await refresh();
        return true;
      } catch (error) {
        reportError(error);
        await refresh().catch(reportError);
        return false;
      } finally {
        pendingMutations -= 1;
        set({ isApplying: pendingMutations > 0 });
      }
    });
    mutationTail = task.then(() => undefined);
    return task;
  };

  const providerChanges = (config: WebSearchConfig, id: string, updates: ProviderUpdates): ConfigFieldMutation[] => {
    const current = config.providers[id];
    if (!current) throw new Error('Search provider is no longer configured.');
    const changes: ConfigFieldMutation[] = Object.entries(updates).flatMap<ConfigFieldMutation>(([field, value]) => {
      const pathTemplate = `/providers/${id}/${field}`;
      if (value === undefined) return field in current ? [{ op: 'remove' as const, pathTemplate }] : [];
      return [{ op: 'set' as const, pathTemplate, value }];
    });
    if (updates.enabled === false && config.defaultProvider === id) {
      changes.push({ op: 'set', pathTemplate: '/defaultProvider', value: null });
    }
    return changes;
  };

  return {
    config: null, descriptor: null, presets: [], isLoading: false, isApplying: false, connecting: {}, authorizationResults: {}, error: null,
    refresh,
    subscribeToConfigChanges: () => subscribeToConfigDomainRevisions({
      domain: 'web-search',
      subscribe: (listener) => window.piskie.configuration.observeChanges(listener),
      getSnapshot: () => ({ revision: get().config?.revision, descriptorHash: get().descriptor?.descriptorHash }),
      refresh, onError: reportError,
    }),
    addProvider: (id) => commit((config) => {
      if (config.providers[id]) return [];
      const preset = get().presets.find((item) => item.id === id);
      if (!preset) throw new Error('Search provider preset is unavailable.');
      const changes: ConfigFieldMutation[] = [{
        op: 'set', pathTemplate: `/providers/${id}`,
        value: { displayName: preset.label, enabled: true, authentication: preset.defaults.authentication, options: preset.defaults.options },
      }];
      if (Object.keys(config.providers).length === 0) changes.push({ op: 'set', pathTemplate: '/defaultProvider', value: id });
      return changes;
    }),
    updateProvider: (id, updates) => commit((config) => providerChanges(config, id, updates)),
    removeProvider: (id) => commit((config) => {
      const changes: ConfigFieldMutation[] = [{ op: 'remove', pathTemplate: `/providers/${id}` }];
      if (config.defaultProvider === id) changes.push({ op: 'set', pathTemplate: '/defaultProvider', value: null });
      return changes;
    }),
    setDefaultProvider: (id) => commit(() => [{ op: 'set', pathTemplate: '/defaultProvider', value: id }]),
    setEnabled: (enabled) => commit(() => [{ op: 'set', pathTemplate: '/enabled', value: enabled }]),
    async connectOAuth(id) {
      if (get().connecting[id]) return;
      await mutationTail;
      if (get().connecting[id]) return;
      const revision = get().config?.revision;
      if (revision === undefined) return;
      set({ connecting: { ...get().connecting, [id]: true }, authorizationResults: { ...get().authorizationResults, [id]: undefined }, error: null });
      try {
        const result = await window.piskie.webSearch.connectOAuth(id);
        if (!result.ok) {
          if ('cancelled' in result) set({ authorizationResults: { ...get().authorizationResults, [id]: 'cancelled' } });
          else set({ error: messageText(`settings.webSearch.errors.${result.failure.code}`) });
          return;
        }
        set({ authorizationResults: { ...get().authorizationResults, [id]: 'connected' } });
        await refresh();
        const saved = await commit((config) => providerChanges(config, id, { authentication: 'oauth' }), revision);
        if (!saved) set({ error: messageText('settings.webSearch.oauthSettingsChanged') });
      } catch (error) {
        reportError(error);
      } finally {
        set({ connecting: { ...get().connecting, [id]: false } });
        await refresh().catch(reportError);
      }
    },
    async cancelOAuth(id) {
      try { await window.piskie.webSearch.cancelOAuth(id); } catch (error) { reportError(error); }
    },
    async disconnectOAuth(id) {
      try { await window.piskie.webSearch.disconnectOAuth(id); await refresh(); } catch (error) { reportError(error); }
    },
    waitForSaves: () => mutationTail,
    clearError: () => set({ error: null }),
  };
});
