import { create } from 'zustand';
import type {
  AgentIncident,
  AgentIncidentChange,
} from '../../shared/types';

const isElectron = () => typeof window !== 'undefined' && window.piskie?.runtime.host === 'electron';

interface IncidentStore {
  incidents: AgentIncident[];
  setIncidents: (incidents: AgentIncident[]) => void;
  addIncident: (incident: AgentIncident) => void;
  updateIncident: (incident: AgentIncident) => void;
  removeIncident: (id: string) => void;
  clearIncidents: () => void;
  clearIncident: (id: string) => Promise<boolean>;
  clearAllIncidents: () => Promise<boolean>;
}

export const useIncidentStore = create<IncidentStore>((set) => ({
  incidents: [],
  setIncidents: (incidents) => set({ incidents }),
  addIncident: (incident) => set((state) => ({
    incidents: [incident, ...state.incidents.filter((current) => current.id !== incident.id)],
  })),
  updateIncident: (incident) => set((state) => ({
    incidents: state.incidents.map((current) => (
      current.id === incident.id ? incident : current
    )),
  })),
  removeIncident: (id) => set((state) => ({
    incidents: state.incidents.filter((incident) => incident.id !== id),
  })),
  clearIncidents: () => set({ incidents: [] }),
  clearIncident: async (id) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.observability.incidents.clear(id);
      return true;
    } catch (error) {
      console.error('Failed to clear agent incident:', error);
      return false;
    }
  },
  clearAllIncidents: async () => {
    if (!isElectron()) return false;
    try {
      await window.piskie.observability.incidents.clearAll();
      return true;
    } catch (error) {
      console.error('Failed to clear agent incidents:', error);
      return false;
    }
  },
}));

export function subscribeToIncidentEvents(): () => void {
  if (!isElectron()) return () => {};

  return window.piskie.observability.incidents.observe({
    onSnapshot(incidents) {
      useIncidentStore.getState().setIncidents(incidents);
    },
    onChange(change: AgentIncidentChange) {
      const store = useIncidentStore.getState();
      switch (change.type) {
        case 'added':
          store.addIncident(change.incident);
          break;
        case 'updated':
          store.updateIncident(change.incident);
          break;
        case 'removed':
          store.removeIncident(change.incident.id);
          break;
        case 'cleared':
          store.clearIncidents();
          break;
      }
    },
  });
}
