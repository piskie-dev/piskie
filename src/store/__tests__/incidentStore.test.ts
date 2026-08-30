import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiskieDesktopApi } from '../../../shared/electron-contracts/index.js';
import type { AgentIncident } from '../../../shared/types/agent-incidents.js';

type IncidentObserver = Parameters<PiskieDesktopApi['observability']['incidents']['observe']>[0];

let observer: IncidentObserver;
let useIncidentStore: typeof import('../incidentStore').useIncidentStore;
let subscribeToIncidentEvents: typeof import('../incidentStore').subscribeToIncidentEvents;

const unsubscribe = vi.fn();
const observe = vi.fn((next: IncidentObserver) => {
  observer = next;
  return unsubscribe;
});

function incident(id: string): AgentIncident {
  return {
    id,
    timestamp: new Date('2026-08-19T00:00:00.000Z'),
    severity: 'error',
    category: 'system',
    source: { agentId: 'agent-1' },
    message: id,
    autoRecovered: false,
  };
}

beforeAll(async () => {
  vi.stubGlobal('window', {
    piskie: {
      runtime: { host: 'electron' },
      observability: {
        incidents: {
          observe,
          clear: vi.fn(),
          clearAll: vi.fn(),
        },
      },
    },
  });
  ({ subscribeToIncidentEvents, useIncidentStore } = await import('../incidentStore'));
});

beforeEach(() => {
  observe.mockClear();
  unsubscribe.mockClear();
  useIncidentStore.getState().clearIncidents();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('incidentStore subscription', () => {
  it('replaces local state from the snapshot before applying changes', () => {
    useIncidentStore.getState().setIncidents([incident('stale')]);
    const dispose = subscribeToIncidentEvents();
    const canonical = incident('canonical');

    observer.onSnapshot([canonical]);
    observer.onChange({ type: 'added', incident: incident('new') });

    expect(useIncidentStore.getState().incidents).toEqual([
      expect.objectContaining({ id: 'new' }),
      canonical,
    ]);
    expect(dispose).toBe(unsubscribe);
  });
});
