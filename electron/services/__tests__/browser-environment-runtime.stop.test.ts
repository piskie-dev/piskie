import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserEnvironment } from '../../../shared/types/index.js';
import type { Occupancy } from '../../../shared/types/occupancy.js';

const h = vi.hoisted(() => ({
  environment: {
    id: 'p1',
    name: 'P1',
    status: 'idle',
    createdAt: 1,
    identityPolicy: {
      timezone: { mode: 'real' },
      geolocation: { mode: 'off' },
      language: { mode: 'custom', value: 'en-US' },
    },
  } as BrowserEnvironment,
  occupancies: new Map<string, Occupancy>(),
  stopSubagent: vi.fn(async () => undefined),
  stopAgent: vi.fn(async () => undefined),
  closeBrowser: vi.fn(async () => ({ success: true })),
}));

vi.mock('electron', () => ({ screen: { getPrimaryDisplay: vi.fn() } }));
vi.mock('../browser-environment-runtime-projection.js', () => ({
  BrowserEnvironmentRuntimeProjection: class {
    getEnvironment() { return h.environment; }
    updateRuntimeEnvironment(_id: string, updates: Record<string, unknown>) {
      h.environment = { ...h.environment, ...updates };
      return h.environment;
    }
    listEnvironments() { return [h.environment]; }
    listGroups() { return []; }
  },
}));
vi.mock('../../core/pilot/index.js', () => ({
  browserControlPort: {
    closeBrowser: h.closeBrowser,
  },
}));
vi.mock('../../core/occupancy/index.js', () => ({
  occupancyRegistry: { find: (key: string) => h.occupancies.get(key) },
}));
vi.mock('../agent.service.js', () => ({
  agentService: { stopSubagent: h.stopSubagent, stopAgent: h.stopAgent },
}));


import { browserEnvironmentRuntime } from '../browser-environment-runtime.js';

beforeAll(async () => {
  await browserEnvironmentRuntime.initialize();
});

beforeEach(() => {
  h.environment = {
    id: 'p1',
    name: 'P1',
    status: 'idle',
    createdAt: 1,
    identityPolicy: {
      timezone: { mode: 'real' },
      geolocation: { mode: 'off' },
      language: { mode: 'custom', value: 'en-US' },
    },
  };
  h.occupancies.clear();
  h.stopSubagent.mockClear();
  h.stopAgent.mockClear();
  h.closeBrowser.mockClear();
});

describe('BrowserEnvironmentRuntime stop with agent occupant', () => {
  it('stops the top-level flow directly when the occupant is itself top-level', async () => {
    h.occupancies.set('browserEnvironment:p1', { occupantId: 'main-1', ownerId: 'main-1' });
    await browserEnvironmentRuntime.stopBrowser('p1');

    expect(h.stopAgent).toHaveBeenCalledWith('main-1');
    expect(h.stopSubagent).not.toHaveBeenCalled();
  });

  it('stops only the owned holder subagent and lets its teardown close the browser', async () => {
    h.environment = { ...h.environment, status: 'running', currentBrowserId: 'environment-p1' };
    h.occupancies.set('browserEnvironment:p1', { occupantId: 'sub-1', ownerId: 'main-1' });
    h.stopSubagent.mockImplementationOnce(async () => {
      h.environment = { ...h.environment, status: 'idle', currentBrowserId: undefined };
    });
    await browserEnvironmentRuntime.stopBrowser('p1');

    expect(h.stopSubagent).toHaveBeenCalledWith('sub-1');
    expect(h.stopAgent).not.toHaveBeenCalled();
    expect(h.closeBrowser).not.toHaveBeenCalled();
  });

  it('returns a borrowed browser to the agent and then closes the manual window', async () => {
    h.environment = { ...h.environment, status: 'running', currentBrowserId: 'environment-p1' };
    h.occupancies.set('browserEnvironment:p1', { occupantId: 'sub-1', ownerId: 'main-1' });
    await browserEnvironmentRuntime.stopBrowser('p1');

    expect(h.stopSubagent).toHaveBeenCalledWith('sub-1');
    expect(h.closeBrowser).toHaveBeenCalledWith({ browserId: 'environment-p1' });
    expect(h.environment.status).toBe('idle');
  });

  it('keeps the existing manual-only stop path when nothing occupies the environment', async () => {
    h.environment = { ...h.environment, status: 'running', currentBrowserId: 'environment-p1' };
    await browserEnvironmentRuntime.stopBrowser('p1');

    expect(h.stopSubagent).not.toHaveBeenCalled();
    expect(h.closeBrowser).toHaveBeenCalledWith({ browserId: 'environment-p1' });
  });
});
