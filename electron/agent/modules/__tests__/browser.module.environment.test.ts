import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  borrowed: false,
  claim: vi.fn(() => ({ ok: true })),
  hasBrowser: vi.fn(() => false),
  planLaunch: vi.fn(async () => ({
    generation: 'browser-generation-1',
    browserId: 'environment-p1',
    userDataId: 'login-p1',
    identity: {},
    fingerprint: {},
    backgroundMode: true,
  })),
  launch: vi.fn(async () => undefined),
  closeBrowser: vi.fn(async () => ({ success: true })),
  recordStarted: vi.fn(),
  recordStopped: vi.fn(),
  loadSkillDocs: vi.fn(async () => '# Browser'),
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../../../core/occupancy/index.js', () => ({
  occupancyRegistry: { claim: h.claim },
}));
vi.mock('../../../services/browser-environment-runtime.js', () => ({
  browserEnvironmentRuntime: {
    getEnvironment: () => ({ id: 'p1', name: 'P1', userDataId: 'login-p1' }),
    planLaunch: h.planLaunch,
    recordAgentBrowserStarted: h.recordStarted,
    recordAgentBrowserStopped: h.recordStopped,
  },
}));


import { BrowserModule } from '../browser.module.js';
import type { AgentHost } from '../../agent-host.js';

function makeModule() {
  const browser = {
    hasBrowser: h.hasBrowser,
    launch: h.launch,
    closeBrowser: h.closeBrowser,
  };
  const host = {
    id: 'browser-parent-1',
    spec: { name: 'browser-worker' },
    getSkillCatalog: () => ({ loadSkillDocs: h.loadSkillDocs }),
    getBrowserControl: () => browser,
    setSkillDocs: vi.fn(),
    getSkillDocs: () => '',
    emitStateChange: vi.fn(),
  } as unknown as AgentHost;
  const module = new BrowserModule();
  module.init(host, {
    mode: 'browser',
    mainAgentId: 'parent-1',
    browserEnvironmentId: 'p1',
    binding: { browserId: 'environment-p1', userDataId: 'login-p1' },
  });
  return module;
}

beforeEach(() => {
  h.borrowed = false;
  h.claim.mockReset();
  h.claim.mockReturnValue({ ok: true });
  h.hasBrowser.mockReset();
  h.hasBrowser.mockImplementation(() => h.borrowed);
  h.planLaunch.mockClear();
  h.launch.mockClear();
  h.closeBrowser.mockClear();
  h.recordStarted.mockClear();
  h.recordStopped.mockClear();
  h.loadSkillDocs.mockClear();
});

describe('BrowserModule bound environment ownership', () => {
  it('owned uses stable environment browser/user-data IDs and closes on destroy', async () => {
    const module = makeModule();
    await module.onStart();

    expect(module.getBrowserId()).toBe('environment-p1');
    expect(h.planLaunch).toHaveBeenCalledWith(
      'p1',
      'environment-p1',
      'login-p1',
      true,
    );
    expect(h.launch).toHaveBeenCalledWith(expect.objectContaining({
      generation: 'browser-generation-1',
      browserId: 'environment-p1',
      userDataId: 'login-p1',
    }));
    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.claim).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'browserEnvironment',
      resourceId: 'login-p1',
      occupantName: 'browser-worker',
    }));
    expect(h.claim).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'browserInstance',
      resourceId: 'environment-p1',
      occupantName: 'browser-worker',
    }));
    expect(h.hasBrowser.mock.invocationCallOrder[0]).toBeGreaterThan(h.claim.mock.invocationCallOrder[1]);
    expect(h.loadSkillDocs).toHaveBeenCalledWith(['core']);
    expect(h.recordStarted).toHaveBeenCalledWith(
      'p1',
      'environment-p1',
      'login-p1',
    );
    await module.onDestroyBegin();
    expect(h.closeBrowser).toHaveBeenCalledWith({ browserId: 'environment-p1' });
    expect(h.recordStopped).toHaveBeenCalledWith('p1', 'environment-p1');
  });

  it('borrowed does not overwrite config and returns the browser without closing', async () => {
    h.borrowed = true;
    const module = makeModule();
    await module.onStart();

    expect(h.planLaunch).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.recordStarted).not.toHaveBeenCalled();
    await module.onDestroyBegin();
    expect(h.closeBrowser).not.toHaveBeenCalled();
    expect(h.recordStopped).not.toHaveBeenCalled();
  });

  it('does not close the current holder browser when the bound environment claim is rejected', async () => {
    h.claim.mockReturnValueOnce({
      ok: false,
      heldBy: { occupantName: 'other-subagent' },
    });
    const module = makeModule();

    await expect(module.onStart()).rejects.toThrow('other-subagent');
    await module.onDestroyBegin();

    expect(h.launch).not.toHaveBeenCalled();
    expect(h.hasBrowser).not.toHaveBeenCalled();
    expect(h.closeBrowser).not.toHaveBeenCalled();
  });

  it('does not decide ownership or close when the instance claim is rejected', async () => {
    h.claim
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({
        ok: false,
        heldBy: { occupantName: 'other-instance-holder' },
      });
    const module = makeModule();

    await expect(module.onStart()).rejects.toThrow('other-instance-holder');
    await module.onDestroyBegin();

    expect(h.hasBrowser).not.toHaveBeenCalled();
    expect(h.planLaunch).not.toHaveBeenCalled();
    expect(h.closeBrowser).not.toHaveBeenCalled();
  });
});
