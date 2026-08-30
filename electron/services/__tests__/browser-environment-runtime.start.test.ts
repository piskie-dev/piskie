import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserEnvironment } from '../../../shared/types/index.js';

const h = vi.hoisted(() => ({
  environment: {
    id: 'p1',
    name: 'P1',
    status: 'idle',
    createdAt: 1,
    proxyId: 'proxy-a',
    identityPolicy: {
      timezone: { mode: 'real' },
      geolocation: { mode: 'off' },
      language: { mode: 'custom', value: 'en-US' },
    },
  } as BrowserEnvironment,
  plan: vi.fn(),
  launch: vi.fn(),
  navigate: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  getAllCookies: vi.fn(),
}));

vi.mock('electron', () => ({ screen: { getPrimaryDisplay: vi.fn() } }));
vi.mock('../browser-environment-runtime-projection.js', () => ({
  BrowserEnvironmentRuntimeProjection: class {
    getEnvironment() { return h.environment; }
    publishConfigSnapshot(snapshot: { environments: typeof h.environment[] }) {
      h.environment = snapshot.environments[0];
    }
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
    launch: h.launch,
    navigateTo: h.navigate,
    showWindow: h.show,
    closeBrowser: h.close,
    getAllCookies: h.getAllCookies,
  },
}));
vi.mock('../../core/pilot/launch/index.js', () => ({
  browserLaunchPlanner: { planEnvironment: h.plan },
}));
vi.mock('../../core/occupancy/index.js', () => ({
  occupancyRegistry: { find: () => undefined },
}));


import { BrowserEnvironmentRuntime } from '../browser-environment-runtime.js';

let runtime: BrowserEnvironmentRuntime;

beforeAll(async () => {
  runtime = new BrowserEnvironmentRuntime();
  await runtime.initialize();
});

beforeEach(() => {
  h.environment = {
    id: 'p1',
    name: 'P1',
    status: 'idle',
    createdAt: 1,
    proxyId: 'proxy-a',
    identityPolicy: {
      timezone: { mode: 'real' },
      geolocation: { mode: 'off' },
      language: { mode: 'custom', value: 'en-US' },
    },
  };
  h.plan.mockReset().mockResolvedValue({
    generation: 'generation-a',
    browserId: 'environment-p1',
    userDataId: 'p1',
    identity: { language: 'en-US' },
    fingerprint: {},
    backgroundMode: false,
  });
  h.launch.mockReset().mockResolvedValue(undefined);
  h.navigate.mockReset().mockResolvedValue(undefined);
  h.show.mockReset().mockResolvedValue(true);
  h.close.mockReset().mockResolvedValue({ success: true });
  h.getAllCookies.mockReset();
});

describe('BrowserEnvironmentRuntime owned browser launch transaction', () => {
  it('accepts configuration published before runtime initialization', async () => {
    const freshRuntime = new BrowserEnvironmentRuntime();
    const published = { ...h.environment, id: 'published-before-start' };

    freshRuntime.publishConfigSnapshot({ environments: [published], groups: [] });
    await freshRuntime.initialize();

    expect(freshRuntime.getEnvironment('published-before-start')).toBe(published);
  });

  it('does not spawn when planning fails', async () => {
    h.plan.mockRejectedValueOnce(new Error('identity lookup failed'));

    await expect(runtime.startBrowser('p1')).rejects.toThrow('identity lookup failed');

    expect(h.launch).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.environment.status).toBe('idle');
  });

  it('rolls back a newly launched browser when navigation fails', async () => {
    h.navigate.mockRejectedValueOnce(new Error('navigation failed'));

    await expect(runtime.startBrowser('p1')).rejects.toThrow('navigation failed');

    expect(h.launch).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledWith({ browserId: 'environment-p1' });
    expect(h.environment.status).toBe('idle');
  });

  it('surfaces both the launch transaction error and rollback failure', async () => {
    h.show.mockRejectedValueOnce(new Error('show failed'));
    h.close.mockRejectedValueOnce(new Error('close failed'));

    await expect(runtime.startBrowser('p1')).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Browser launch rollback failed',
    });
    expect(h.environment.status).toBe('idle');
  });

  it('publishes running state only after plan, launch, navigation and show succeed', async () => {
    await expect(runtime.startBrowser('p1')).resolves.toMatchObject({
      status: 'running',
      currentBrowserId: 'environment-p1',
      userDataId: 'p1',
    });

    expect(h.plan).toHaveBeenCalledWith(expect.objectContaining({
      proxyId: 'proxy-a',
      browserId: 'environment-p1',
      userDataId: 'p1',
    }), { signal: undefined });
    expect(h.launch.mock.invocationCallOrder[0]).toBeLessThan(h.navigate.mock.invocationCallOrder[0]!);
    expect(h.navigate.mock.invocationCallOrder[0]).toBeLessThan(h.show.mock.invocationCallOrder[0]!);
    expect(h.close).not.toHaveBeenCalled();
  });
});

describe('BrowserEnvironmentRuntime agent-owned browser projection', () => {
  it('projects a successful Agent launch and its matching teardown', () => {
    expect(runtime.recordAgentBrowserStarted('p1', 'environment-p1', 'login-p1')).toMatchObject({
      status: 'running',
      currentBrowserId: 'environment-p1',
      userDataId: 'login-p1',
    });

    expect(runtime.recordAgentBrowserStopped('p1', 'environment-p1')).toMatchObject({
      status: 'idle',
      currentBrowserId: undefined,
    });
  });

  it('does not let a stale teardown clear a newer browser projection', () => {
    runtime.recordAgentBrowserStarted('p1', 'environment-new', 'login-p1');

    expect(runtime.recordAgentBrowserStopped('p1', 'environment-old')).toMatchObject({
      status: 'running',
      currentBrowserId: 'environment-new',
    });
  });
});

describe('BrowserEnvironmentRuntime login trail projection', () => {
  it('returns only aggregated site metadata to the renderer', async () => {
    h.environment = {
      ...h.environment,
      status: 'running',
      currentBrowserId: 'environment-p1',
    };
    h.getAllCookies.mockResolvedValue({
      success: true,
      count: 4,
      cookies: [
        { domain: '.accounts.google.com', name: 'session', value: 'secret-a' },
        { domain: 'mail.google.com', name: 'other', value: 'secret-b' },
        { domain: '.shop.example.co.uk', name: 'cart', value: 'secret-c' },
        { domain: '', name: 'ignored', value: 'secret-d' },
      ],
    });

    await expect(runtime.captureLoginTrail('p1')).resolves.toEqual([
      { host: 'google.com', jar: 2 },
      { host: 'example.co.uk', jar: 1 },
    ]);
    expect(h.getAllCookies).toHaveBeenCalledWith({ browserId: 'environment-p1' });
  });
});
