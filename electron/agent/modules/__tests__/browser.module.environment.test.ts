import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserLaunchSpec } from '../../../piskiepilot/browser/core/browser/browser-launch-spec.js';

const h = vi.hoisted(() => {
  const cancelDeferredLaunch = vi.fn();
  return {
    claim: vi.fn((): { ok: boolean; heldBy?: { occupantName: string } } => ({ ok: true })),
    hasBrowser: vi.fn(() => false),
    planLaunch: vi.fn(async () => ({
      generation: 'sample-generation',
      browserId: 'sample-browser',
      userDataId: 'sample-profile',
      identity: {},
      fingerprint: {},
      backgroundMode: true,
    })),
    launch: vi.fn(async () => undefined),
    cancelDeferredLaunch,
    deferLaunch: vi.fn((
      _browserId: string,
      _plan: (signal: AbortSignal) => Promise<BrowserLaunchSpec>,
      _onConnected: () => void,
    ) => cancelDeferredLaunch),
    closeBrowser: vi.fn(async () => undefined),
    recordStarted: vi.fn(),
    recordStopped: vi.fn(),
    loadSkillDocs: vi.fn(async () => '# Sample browser guide'),
  };
});

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../../../core/occupancy/index.js', () => ({
  occupancyRegistry: { claim: h.claim },
}));
vi.mock('../../../services/browser-environment-runtime.js', () => ({
  browserEnvironmentRuntime: {
    planLaunch: h.planLaunch,
    recordAgentBrowserStarted: h.recordStarted,
    recordAgentBrowserStopped: h.recordStopped,
  },
}));

import { BrowserModule } from '../browser.module.js';
import type { AgentHost } from '../../agent-host.js';

function makeModule(name = 'browser-worker') {
  const browser = {
    hasBrowser: h.hasBrowser,
    launch: h.launch,
    deferLaunch: h.deferLaunch,
    closeBrowser: h.closeBrowser,
  };
  const host = {
    id: 'sample-worker',
    spec: { name },
    getSkillCatalog: () => ({ loadSkillDocs: h.loadSkillDocs }),
    getBrowserControl: () => browser,
    setSkillDocs: vi.fn(),
    getSkillDocs: () => '',
    emitStateChange: vi.fn(),
  } as unknown as AgentHost;
  const module = new BrowserModule();
  module.init(host, {
    mainAgentId: 'sample-parent',
    browserEnvironmentId: 'sample-environment',
    binding: { browserId: 'sample-browser', userDataId: 'sample-profile' },
  });
  return module;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.claim.mockReset();
  h.claim.mockReturnValue({ ok: true });
});

describe('BrowserModule bound environment ownership', () => {
  it.each(['browser-worker', 'site-scout', 'browser-skill-builder', 'browser-skill-verifier'])(
    '%s reserves stable browser/profile IDs and loads docs without launching',
    async (name) => {
      const module = makeModule(name);
      await module.onStart();

      expect(module.getBrowserId()).toBe('sample-browser');
      expect(module.getBrowserReady()).toBe(false);
      expect(h.claim).toHaveBeenCalledTimes(2);
      expect(h.claim).toHaveBeenNthCalledWith(1, expect.objectContaining({
        kind: 'browserEnvironment',
        resourceId: 'sample-profile',
        occupantId: 'sample-worker',
        ownerId: 'sample-parent',
        occupantName: name,
      }));
      expect(h.claim).toHaveBeenNthCalledWith(2, expect.objectContaining({
        kind: 'browserInstance',
        resourceId: 'sample-browser',
        occupantName: name,
      }));
      expect(h.deferLaunch.mock.invocationCallOrder[0]).toBeGreaterThan(h.claim.mock.invocationCallOrder[1]);
      expect(h.loadSkillDocs).toHaveBeenCalledWith(['core']);
      expect(h.planLaunch).not.toHaveBeenCalled();
      expect(h.hasBrowser).not.toHaveBeenCalled();
      expect(h.launch).not.toHaveBeenCalled();
      expect(h.recordStarted).not.toHaveBeenCalled();

      await module.onDestroyBegin();
      expect(h.cancelDeferredLaunch).toHaveBeenCalledOnce();
      expect(h.closeBrowser).toHaveBeenCalledWith({ browserId: 'sample-browser' });
      expect(h.recordStopped).toHaveBeenCalledWith('sample-environment', 'sample-browser');
      expect(h.launch).not.toHaveBeenCalled();
    },
  );

  it('plans a bound launch with the lifecycle signal only on demand', async () => {
    const module = makeModule();
    await module.onStart();
    const [, plan, onConnected] = h.deferLaunch.mock.calls[0];
    const signal = new AbortController().signal;

    await expect(plan(signal)).resolves.toMatchObject({
      generation: 'sample-generation', browserId: 'sample-browser', userDataId: 'sample-profile',
    });
    expect(h.planLaunch).toHaveBeenCalledWith(
      'sample-environment', 'sample-browser', 'sample-profile', true, signal,
    );
    expect(h.recordStarted).not.toHaveBeenCalled();
    onConnected();
    expect(h.recordStarted).toHaveBeenCalledWith(
      'sample-environment', 'sample-browser', 'sample-profile',
    );
    expect(module.getBrowserReady()).toBe(true);
  });

  it('records acquired borrowed browsers without planning and still closes them on destroy', async () => {
    const module = makeModule();
    await module.onStart();
    const [, , onConnected] = h.deferLaunch.mock.calls[0];
    onConnected();

    expect(h.planLaunch).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.recordStarted).toHaveBeenCalledOnce();
    await module.onDestroyBegin();
    expect(h.closeBrowser).toHaveBeenCalledWith({ browserId: 'sample-browser' });
    expect(h.recordStopped).toHaveBeenCalledWith('sample-environment', 'sample-browser');
    onConnected();
    expect(h.recordStarted).toHaveBeenCalledOnce();
  });

  it('does not acquire a browser when startup follows destroy', async () => {
    const module = makeModule();
    await module.onDestroyBegin();
    await module.onStart();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.deferLaunch).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('does not close the current holder browser when the bound environment claim is rejected', async () => {
    h.claim.mockReturnValueOnce({
      ok: false,
      heldBy: { occupantName: 'sample-other-worker' },
    });
    const module = makeModule();

    await expect(module.onStart()).rejects.toThrow('sample-other-worker');
    await module.onDestroyBegin();

    expect(h.deferLaunch).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.closeBrowser).not.toHaveBeenCalled();
  });

  it('does not register or close when the instance claim is rejected', async () => {
    h.claim
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({
        ok: false,
        heldBy: { occupantName: 'sample-other-holder' },
      });
    const module = makeModule();

    await expect(module.onStart()).rejects.toThrow('sample-other-holder');
    await module.onDestroyBegin();

    expect(h.deferLaunch).not.toHaveBeenCalled();
    expect(h.planLaunch).not.toHaveBeenCalled();
    expect(h.closeBrowser).not.toHaveBeenCalled();
  });
});
