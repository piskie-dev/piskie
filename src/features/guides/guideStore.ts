import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { GUIDE_IDS, type GuideId } from './catalog';

export type { GuideId } from './catalog';
export type GuideStatus = 'dismissed' | 'understood';
type GuideStatuses = Partial<Record<GuideId, GuideStatus>>;

interface GuideStore {
  statuses: GuideStatuses;
  dismiss: (id: GuideId) => void;
  understand: (id: GuideId) => void;
}

export function readGuideStatuses(value: unknown): GuideStatuses {
  if (!value || typeof value !== 'object') return {};
  const statuses = (value as { statuses?: unknown }).statuses;
  if (!statuses || typeof statuses !== 'object') return {};
  const restored: GuideStatuses = Object.fromEntries(GUIDE_IDS.flatMap((id) => {
    const status = (statuses as Record<string, unknown>)[id];
    return status === 'dismissed' || status === 'understood' ? [[id, status]] : [];
  }));
  const previousPlan = (statuses as Record<string, unknown>)['plan-mode'];
  if (!restored['getting-started'] && (previousPlan === 'dismissed' || previousPlan === 'understood')) {
    restored['getting-started'] = previousPlan;
  }
  return restored;
}

export const useGuideStore = create<GuideStore>()(persist(
  (set) => ({
    statuses: {},
    dismiss: (id) => set((state) => ({
      statuses: { ...state.statuses, [id]: state.statuses[id] ?? 'dismissed' },
    })),
    understand: (id) => set((state) => ({
      statuses: { ...state.statuses, [id]: 'understood' },
    })),
  }),
  {
    name: 'piskie-feature-guides',
    version: 2,
    // Guide preferences must not prevent the input from mounting if storage is unavailable.
    storage: createJSONStorage(() => ({
      getItem: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
      setItem: (key, value) => { try { localStorage.setItem(key, value); } catch { /* Session-only state. */ } },
      removeItem: (key) => { try { localStorage.removeItem(key); } catch { /* Session-only state. */ } },
    })),
    partialize: (state) => ({ statuses: state.statuses }),
    migrate: (value) => ({ statuses: readGuideStatuses(value) }),
    merge: (value, current) => ({ ...current, statuses: readGuideStatuses(value) }),
  },
));
