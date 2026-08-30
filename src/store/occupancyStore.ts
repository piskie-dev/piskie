/**
 * 占用登记 Store：谁正在独占哪个浏览器环境或浏览器实例。
 */

import { create } from 'zustand';
import type { Occupancy } from '../../shared/types/occupancy';

interface OccupancyState {
  occupancies: Occupancy[];
  fetchOccupancies: () => Promise<void>;
}

export const useOccupancyStore = create<OccupancyState>((set) => ({
  occupancies: [],

  fetchOccupancies: async () => {
    try {
      set({ occupancies: await window.piskie.observability.occupancy.list() });
    } catch (error) {
      console.error('Failed to fetch occupancies', error);
    }
  },
}));

/** 订阅占用变更；在应用初始化时调用。 */
export function subscribeToOccupancyEvents(): () => void {
  return window.piskie.observability.occupancy.observe((occupancies) => {
    useOccupancyStore.setState({ occupancies });
  });
}
