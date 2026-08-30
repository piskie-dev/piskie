/**
 * 代理配置 Store
 * 管理全局代理池的状态
 */

import { create } from 'zustand';
import type { ProxyProbeResult } from '../../shared/types/proxy';
import type {
  ProxyCreateInput,
  ProxyUpdateInput,
  ProxyPoolSnapshot,
  ProxyProfile,
} from '../../shared/electron-contracts/configuration';

interface ProxyState {
  config: ProxyPoolSnapshot | null;
  testResults: Record<string, ProxyProbeResult>;
  testingIds: Set<string>;
  fetchConfig: () => Promise<void>;
  addProxy: (proxy: ProxyCreateInput) => Promise<ProxyProfile | null>;
  updateProxy: (id: string, updates: ProxyUpdateInput) => Promise<boolean>;
  removeProxy: (id: string) => Promise<boolean>;
  testProxy: (id: string) => Promise<ProxyProbeResult | null>;
}

export const useProxyStore = create<ProxyState>()((set, get) => ({
  config: null,
  testResults: {},
  testingIds: new Set(),

  fetchConfig: async () => {
    try {
      set({ config: await window.piskie.configuration.proxy.read() });
    } catch (error) {
      console.error('Failed to fetch proxy config:', error);
    }
  },

  addProxy: async (proxy) => {
    try {
      const created = await window.piskie.configuration.proxy.add(proxy);
      await get().fetchConfig();
      return created;
    } catch (error) {
      console.error('Failed to add proxy:', error);
      return null;
    }
  },

  updateProxy: async (id, updates) => {
    try {
      await window.piskie.configuration.proxy.update(id, updates);
      await get().fetchConfig();
      return true;
    } catch (error) {
      console.error('Failed to update proxy:', error);
      return false;
    }
  },

  removeProxy: async (id) => {
    try {
      await window.piskie.configuration.proxy.remove(id);
      await get().fetchConfig();
      set((state) => {
        const newResults = { ...state.testResults };
        delete newResults[id];
        return { testResults: newResults };
      });
      return true;
    } catch (error) {
      console.error('Failed to remove proxy:', error);
      return false;
    }
  },

  testProxy: async (id) => {
    set((state) => ({
      testingIds: new Set([...state.testingIds, id]),
    }));
    try {
      const result = await window.piskie.configuration.proxy.test(id);
      set((state) => ({
        testResults: { ...state.testResults, [id]: result },
        testingIds: new Set([...state.testingIds].filter((i) => i !== id)),
      }));
      return result;
    } catch (error) {
      console.error('Failed to test proxy:', error);
      set((state) => ({
        testingIds: new Set([...state.testingIds].filter((i) => i !== id)),
      }));
      return null;
    }
  },
}));
