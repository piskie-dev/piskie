/**
 * Browser environment store
 * 浏览器环境管理（AdsPower 式防关联浏览器）状态
 */

import { create } from 'zustand';
import type { BrowserEnvironment } from '../../shared/types';

const isElectron = () => typeof window !== 'undefined' && window.piskie?.runtime.host === 'electron';

interface BrowserEnvironmentStore {
  environments: BrowserEnvironment[];
  isLoading: boolean;
  error: string | null;

  fetchEnvironments: () => Promise<BrowserEnvironment[]>;
}

let latestEnvironmentRequest = 0;

export const useBrowserEnvironmentStore = create<BrowserEnvironmentStore>((set, get) => ({
  environments: [],
  isLoading: false,
  error: null,

  fetchEnvironments: async () => {
    if (!isElectron()) return get().environments;
    const request = ++latestEnvironmentRequest;
    set({ isLoading: true, error: null });
    try {
      const environments = await window.piskie.pilot.environments.list();
      if (request === latestEnvironmentRequest) {
        set({ environments });
      }
      return environments;
    } catch (error) {
      if (request === latestEnvironmentRequest) {
        set({ error: String(error) });
      }
      return get().environments;
    } finally {
      if (request === latestEnvironmentRequest) {
        set({ isLoading: false });
      }
    }
  },
}));
