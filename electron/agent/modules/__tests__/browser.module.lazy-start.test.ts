import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import puppeteer from 'puppeteer-core';
import type { ToolApprovalDecision } from '../../../../shared/types/index.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sample-app', getAppPath: () => '/tmp/sample-app' },
}));
vi.mock('../../../piskiepilot/runtime/pilot-runtime.js', () => ({
  PilotRuntime: class {
    async initialize() {}
    async dispose() {}
    getExecutableSkills() { return []; }
    bindToolCatalog() {}
  },
}));
vi.mock('../../../piskiepilot/browser/core/browser/webrtc-preferences.js', () => ({
  ensureWebrtcPreferences: vi.fn(async () => undefined),
}));

import { BrowserModule } from '../browser.module.js';
import type { AgentHost } from '../../agent-host.js';
import { ToolCallContextFactory } from '../../tool-call/context-builder.js';
import { occupancyRegistry } from '../../../core/occupancy/index.js';
import { browserControlPort, pilotRuntimeHost } from '../../../core/pilot/pilot-manager.js';
import { browserLaunchPlanner } from '../../../core/pilot/launch/index.js';
import { browserEnvironmentRuntime } from '../../../services/browser-environment-runtime.js';
import { BrowserManager } from '../../../piskiepilot/browser/core/browser/browser-manager.js';
import type { BrowserLaunchSpec } from '../../../piskiepilot/browser/core/browser/browser-launch-spec.js';
import { BrowserAutomationSession } from '../../../piskiepilot/browser/core/session/browser-automation-session.js';
import { WindowController } from '../../../piskiepilot/browser/core/browser/window-controller.js';
import { fingerprintBrowser } from '../../../piskiepilot/browser/fingerprint/runtime.js';
import { attachSkillProvenance, defineSkill, ok, z } from '../../../piskiepilot/core/skill/define.js';
import builtinBrowser from '../../../piskiepilot/browser/skills/browser/skill.js';
import { ToolCatalog } from '../../../tools/catalog.js';
import { ToolCoordinator } from '../../../tools/coordinator.js';
import type { ApprovalRequestPort } from '../../../tools/pipeline/types.js';
import { REJECT } from '../../../tools/pipeline/rejections.js';
import { buildLoadedSkillEntries } from '../../../tools/skill/domain-descriptors.js';
import { SkillCallTool } from '../../../tools/skill/skill-call.tool.js';

const BROWSER_ID = 'sample-browser';
const PROFILE_ID = 'sample-profile';
const ENVIRONMENT_ID = 'sample-environment';
const WORKER_ID = 'sample-worker';
const launchSpec: BrowserLaunchSpec = Object.freeze({
  browserId: BROWSER_ID,
  userDataId: PROFILE_ID,
  generation: 'sample-generation',
  identity: { language: 'en-US', userAgent: 'Sample browser agent' },
  fingerprint: { platform: 'linux' as const },
  backgroundMode: true,
});
const manager = BrowserManager as unknown as {
  initialized: boolean;
  readPersistedBrowserConfig(browserId: string): Promise<unknown>;
  savePersisted(browserId: string, config: unknown): Promise<void>;
  deletePersisted(browserId: string): Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function browserFixture() {
  let url = 'about:blank';
  const client = {
    send: vi.fn(async (method: string) => {
      if (method === 'Network.getAllCookies') return { cookies: [] };
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 };
      if (method === 'Browser.getWindowBounds') return { bounds: { width: 800, height: 600 } };
      return {};
    }),
    detach: vi.fn(async () => undefined),
  };
  const page = {
    url: () => url,
    title: vi.fn(async () => 'Sample page'),
    goto: vi.fn(async (nextUrl: string) => { url = nextUrl; }),
    createCDPSession: vi.fn(async () => client),
  };
  const automation = {
    dispose: vi.fn(),
    getScreenTarget: () => ({ page, identity: { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 } }),
    withOperationFeedback: <T>(action: () => Promise<T> | T) => action(),
    getSelectedPage: () => page,
    getSelectedPageIndex: () => 0,
    listPages: vi.fn(async () => [{ pageId: 1, page }]),
    consumePageChanges: vi.fn(async () => ({ opened: [], closed: [] })),
    takeSnapshot: vi.fn(async () => ({
      snapshotId: 1, root: { id: '1_1', role: 'RootWebArea', name: 'Sample page', children: [] },
    })),
    getConsoleData: vi.fn(() => []),
    getNetworkRequests: vi.fn(() => []),
    throwIfDialogOpen: vi.fn(),
    waitForAction: vi.fn(async (action: () => Promise<unknown>) => {
      await action();
      return { navigated: true, domSettled: true, openedPageIds: [], closedPageIds: [] };
    }),
  };
  let connected = true;
  const listeners: Array<() => void> = [];
  const disconnect = vi.fn(async () => {
    connected = false;
    listeners.forEach((listener) => listener());
  });
  const browser = {
    get connected() { return connected; },
    disconnect,
    close: vi.fn(async () => { connected = false; }),
    on: vi.fn((_event: string, listener: () => void) => { listeners.push(listener); }),
    process: () => null,
    wsEndpoint: () => 'ws://example.test/sample-browser',
  };
  return { browser, automation, page, client };
}

const modules: BrowserModule[] = [];
let fixture: ReturnType<typeof browserFixture>;
const windowSize = vi.fn(() => ({ width: 800, height: 600 }));
const callerWindow = vi.fn(() => ({ windowId: '0x00100001' }));

beforeAll(async () => {
  await pilotRuntimeHost.initialize();
  pilotRuntimeHost.setBrowserLaunchWindowSizeResolver(windowSize);
  pilotRuntimeHost.setCallerWindowResolver(callerWindow);
});

beforeEach(() => {
  fixture = browserFixture();
  manager.initialized = true;
  windowSize.mockClear();
  callerWindow.mockClear();
  vi.spyOn(manager, 'readPersistedBrowserConfig').mockResolvedValue(null);
  vi.spyOn(manager, 'savePersisted').mockResolvedValue(undefined);
  vi.spyOn(manager, 'deletePersisted').mockResolvedValue(undefined);
  vi.spyOn(BrowserAutomationSession, 'create').mockResolvedValue(fixture.automation as never);
  vi.spyOn(WindowController, 'initialize').mockResolvedValue(undefined);
  vi.spyOn(puppeteer, 'connect').mockResolvedValue(fixture.browser as never);
  let running = false;
  vi.spyOn(fingerprintBrowser, 'has').mockImplementation(() => running);
  vi.spyOn(fingerprintBrowser, 'launch').mockImplementation(async () => {
    running = true;
    return { seed: 1, config: { platform: 'linux' }, browserWSEndpoint: 'ws://example.test/sample-browser' } as never;
  });
  vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(undefined);
  vi.spyOn(fingerprintBrowser, 'stop').mockImplementation(async () => { running = false; return true; });
  vi.spyOn(browserEnvironmentRuntime, 'planLaunch').mockResolvedValue(launchSpec);
  vi.spyOn(browserLaunchPlanner, 'planTask').mockResolvedValue(launchSpec);
  vi.spyOn(browserEnvironmentRuntime, 'recordAgentBrowserStarted').mockReturnValue(undefined);
  vi.spyOn(browserEnvironmentRuntime, 'recordAgentBrowserStopped').mockReturnValue(undefined);
});

afterEach(async () => {
  for (const module of modules.splice(0)) {
    await module.onDestroyBegin();
    await module.onDestroy();
  }
  await BrowserManager.close(BROWSER_ID);
  occupancyRegistry.releaseAllOwnedBy('sample-parent');
  vi.restoreAllMocks();
});

afterAll(async () => { await pilotRuntimeHost.stop(); });

async function startModule(boundEnvironment = true) {
  const loadSkillDocs = vi.fn(async () => '# Sample browser guide');
  const setSkillDocs = vi.fn();
  const emitStateChange = vi.fn();
  const module = new BrowserModule();
  module.init({
    id: WORKER_ID,
    mainAgentId: 'sample-parent',
    spec: { name: 'browser-worker' },
    getBrowserControl: () => browserControlPort,
    getSkillCatalog: () => ({ loadSkillDocs }),
    getSkillDocs: () => '',
    setSkillDocs,
    emitStateChange,
  } as unknown as AgentHost, {
    mainAgentId: 'sample-parent',
    binding: { browserId: BROWSER_ID, userDataId: PROFILE_ID },
    ...(boundEnvironment ? { browserEnvironmentId: ENVIRONMENT_ID } : {}),
    advancedSettings: {
      language: 'en-US', userAgent: 'Sample browser agent',
      fingerprint: { platform: 'linux' }, backgroundMode: true,
    },
  });
  modules.push(module);
  await module.onStart();
  return { module, loadSkillDocs, setSkillDocs, emitStateChange };
}

function sdk(module: BrowserModule, signal = new AbortController().signal) {
  return module.createGeneratedRuntime({
    browserId: BROWSER_ID, signal, log: vi.fn(),
    notifyPageOpen: () => module.notifyPageOpen(),
    allowedFileRoots: ['/sample-workspace', '/tmp/sample-worker'],
  });
}

function calls(module: BrowserModule, approval?: ApprovalRequestPort) {
  const custom = attachSkillProvenance(defineSkill({
    name: 'sample-site',
    domain: 'browser',
    functions: {
      metadata: {
        description: 'Return locally available SDK metadata', params: z.object({}),
        async run(_params, ctx) { return ok(Object.keys(ctx.browser).join(', ')); },
      },
      currentPage: {
        description: 'Read the current page', params: z.object({}),
        async run(_params, ctx) { return ok(JSON.stringify(await ctx.browser.page.currentPage())); },
      },
      listPages: {
        description: 'Read the open pages', params: z.object({}),
        async run(_params, ctx) { return ok(JSON.stringify(await ctx.browser.listPages())); },
      },
      navigate: {
        description: 'Navigate to a sample page', params: z.object({ url: z.string() }),
        async run({ url }, ctx) { return ok(JSON.stringify(await ctx.browser.page.navigate(url))); },
      },
    },
  }), { root: '/sample-skills/sample-site', trust: 'custom', entryPoint: 'skill_call' });
  const builtin = attachSkillProvenance(builtinBrowser, {
    root: '/sample-builtins/browser', trust: 'builtin', entryPoint: 'direct',
  });
  const catalog = new ToolCatalog();
  catalog.register(new SkillCallTool(), 'builtin');
  for (const skill of [builtin, custom]) {
    for (const entry of buildLoadedSkillEntries(skill)) {
      catalog.register(entry.tool, skill.provenance.trust, entry.identity);
    }
  }
  const snapshot = catalog.snapshot({
    scope: 'subagent', agentType: 'worker', customTools: ['skill_call'],
    exposedSkillFunctions: Object.keys(builtin.functions).map((name) => `browser_${name}`),
    excluded: new Set(), domains: new Set(['browser']),
  });
  const coordinator = new ToolCoordinator({
    contexts: new ToolCallContextFactory({
      activation: {
        agentType: 'worker', agentSpec: 'browser-worker', agentId: WORKER_ID, mainAgentId: 'sample-parent',
        runConfig: { name: 'Sample run', description: '', promptTemplate: '' },
        resourceIds: { browserId: BROWSER_ID }, browser: module,
        currentModel: () => 'sample-provider::sample-model',
        workspace: { dir: '/sample-workspace', tempDir: '/tmp/sample-worker' },
        modes: { modeId: () => 'normal', approvalMode: () => approval ? 'confirm' : 'auto' },
        post: () => true,
      },
      signal: () => new AbortController().signal,
    }),
    pipeline: approval ? { approval } : undefined,
    observer: { start: vi.fn(), finish: vi.fn() },
  });
  return {
    snapshot,
    async run(functionName: string, custom = false, args: Record<string, unknown> = {}) {
      const result = await coordinator.run({
        modelName: custom ? 'skill_call' : `browser_${functionName}`,
        rawParams: custom ? { skill: 'sample-site', function: functionName, args } : args,
        callId: 'sample-call',
      }, snapshot);
      if ('suspended' in result) throw new Error('Unexpected sample call suspension');
      return result.result;
    },
  };
}

function expectNoStartup() {
  expect(browserEnvironmentRuntime.planLaunch).not.toHaveBeenCalled();
  expect(browserLaunchPlanner.planTask).not.toHaveBeenCalled();
  expect(fingerprintBrowser.launch).not.toHaveBeenCalled();
  expect(puppeteer.connect).not.toHaveBeenCalled();
  expect(browserEnvironmentRuntime.recordAgentBrowserStarted).not.toHaveBeenCalled();
}

describe('Browser launch default geometry', () => {
  it.each([false, true])('uses a launch-time desktop default while preserving backgroundMode=%s', async (backgroundMode) => {
    await browserControlPort.launch({ ...launchSpec, backgroundMode });
    expect(fingerprintBrowser.launch).toHaveBeenCalledWith(PROFILE_ID, expect.objectContaining({
      extraArgs: expect.arrayContaining(['--window-size=800,600', '--window-position=0,0']),
    }), expect.any(AbortSignal));
    expect(windowSize).toHaveBeenCalledOnce();
    expect(WindowController.initialize).toHaveBeenCalledWith(BROWSER_ID, backgroundMode
      ? { startHidden: true, callerWindow: { windowId: '0x00100001' } }
      : { startHidden: false });
    expect(puppeteer.connect).toHaveBeenCalledWith(expect.objectContaining({ defaultViewport: null }));
  });
  it('preserves an explicit caller size instead of substituting the desktop default', async () => {
    await browserControlPort.launch({ ...launchSpec, windowSize: { width: 960, height: 640 } });
    expect(windowSize).not.toHaveBeenCalled();
    expect(fingerprintBrowser.launch).toHaveBeenCalledWith(PROFILE_ID, expect.objectContaining({
      extraArgs: expect.arrayContaining(['--window-size=960,640', '--window-position=0,0']),
    }), expect.any(AbortSignal));
  });
});

describe('BrowserModule lazy browser access', () => {
  it('loads context and builds catalogs and SDK objects without starting or connecting', async () => {
    const { module, loadSkillDocs, setSkillDocs } = await startModule();
    const tools = calls(module);
    expect(tools.snapshot.definitions().length).toBeGreaterThan(0);
    expect(Object.keys(sdk(module))).toEqual(['page', 'listPages', 'selectPage']);
    expect(await tools.run('metadata', true)).toMatchObject({ ok: true });
    expect(loadSkillDocs).toHaveBeenCalledWith(['core']);
    expect(setSkillDocs).toHaveBeenCalledWith(expect.stringContaining('# Sample browser guide'));
    expect(module.getBrowserId()).toBe(BROWSER_ID);
    expect(module.getBrowserReady()).toBe(false);
    expect(browserControlPort.hasBrowser(BROWSER_ID)).toBe(false);
    expect(BrowserManager.ownedIds()).toEqual([]);
    expectNoStartup();
  });

  it.each(['listPages', 'takeSnapshot', 'listConsoleMessages', 'listNetworkRequests', 'getAllCookies', 'getWindowBounds'])(
    'starts on the first builtin %s read and marks its usable Page ready',
    async (functionName) => {
      const { module, emitStateChange } = await startModule();
      expect(await calls(module).run(functionName)).toMatchObject({ ok: true });
      expect(fingerprintBrowser.launch).toHaveBeenCalledOnce();
      expect(puppeteer.connect).toHaveBeenCalledOnce();
      expect(browserEnvironmentRuntime.recordAgentBrowserStarted).toHaveBeenCalledWith(ENVIRONMENT_ID, BROWSER_ID, PROFILE_ID);
      expect(module.getBrowserReady()).toBe(true);
      expect(emitStateChange).toHaveBeenCalledOnce();
      expect(WindowController.initialize).toHaveBeenCalledWith(BROWSER_ID, {
        startHidden: true, callerWindow: { windowId: '0x00100001' },
      });
      expect(fingerprintBrowser.launch).toHaveBeenCalledWith(PROFILE_ID, expect.objectContaining({
        locale: 'en-US', userAgent: 'Sample browser agent',
        extraArgs: expect.arrayContaining(['--window-size=800,600']),
      }), expect.any(AbortSignal));
      expect(windowSize).toHaveBeenCalledOnce();
      expect(callerWindow).toHaveBeenCalledOnce();
    },
  );

  it.each(['currentPage', 'listPages', 'navigate'])(
    'starts a custom SDK %s call through skill_call',
    async (functionName) => {
      const { module } = await startModule();
      expect(await calls(module).run(functionName, true, { url: 'https://example.test/sample' })).toMatchObject({ ok: true });
      expect(fingerprintBrowser.launch).toHaveBeenCalledOnce();
      expect(browserEnvironmentRuntime.recordAgentBrowserStarted).toHaveBeenCalledOnce();
      expect(module.getBrowserReady()).toBe(true);
    },
  );

  it('prepares unbound task settings only on first access', async () => {
    const { module } = await startModule(false);
    expectNoStartup();
    await sdk(module).page.currentPage();
    expect(browserLaunchPlanner.planTask).toHaveBeenCalledWith({
      browserId: BROWSER_ID, userDataId: PROFILE_ID,
      identity: { language: 'en-US', userAgent: 'Sample browser agent' },
      fingerprint: { platform: 'linux' }, backgroundMode: true,
    });
    expect(browserEnvironmentRuntime.planLaunch).not.toHaveBeenCalled();
    expect(browserEnvironmentRuntime.recordAgentBrowserStarted).not.toHaveBeenCalled();
    expect(fingerprintBrowser.launch).toHaveBeenCalledOnce();
  });

  it('reuses an existing browser without replanning and retains borrowed close ownership', async () => {
    await browserControlPort.launch(launchSpec);
    vi.mocked(fingerprintBrowser.launch).mockClear();
    vi.mocked(puppeteer.connect).mockClear();
    const { module } = await startModule();
    expect(browserEnvironmentRuntime.recordAgentBrowserStarted).not.toHaveBeenCalled();
    expect(await calls(module).run('listPages')).toMatchObject({ ok: true });
    expect(browserEnvironmentRuntime.planLaunch).not.toHaveBeenCalled();
    expect(fingerprintBrowser.launch).not.toHaveBeenCalled();
    expect(puppeteer.connect).not.toHaveBeenCalled();
    expect(browserEnvironmentRuntime.recordAgentBrowserStarted).toHaveBeenCalledOnce();
    await module.onDestroyBegin();
    expect(fingerprintBrowser.stop).toHaveBeenCalledWith(PROFILE_ID);
    expect(BrowserManager.ownedIds()).toEqual([]);
  });

  it('shares one startup across concurrent builtin and SDK first visits', async () => {
    const planning = deferred<BrowserLaunchSpec>();
    vi.mocked(browserEnvironmentRuntime.planLaunch).mockReturnValueOnce(planning.promise);
    const { module } = await startModule();
    const runtime = sdk(module);
    const reading = Promise.all([
      module.core.listPages({ browserId: BROWSER_ID }),
      runtime.page.currentPage(),
      runtime.listPages(),
    ]);
    await vi.waitFor(() => expect(browserEnvironmentRuntime.planLaunch).toHaveBeenCalledOnce());
    expect(BrowserManager.ownedIds()).toEqual([BROWSER_ID]);
    expect(browserControlPort.hasBrowser(BROWSER_ID)).toBe(false);
    expect(fingerprintBrowser.launch).not.toHaveBeenCalled();
    planning.resolve(launchSpec);
    const results = await reading;
    expect(results[0]).toContain('about:blank');
    expect(results[1]).toEqual({ url: 'about:blank', title: 'Sample page' });
    expect(results[2]).toHaveLength(1);
    expect(fingerprintBrowser.launch).toHaveBeenCalledOnce();
    expect(puppeteer.connect).toHaveBeenCalledOnce();
    expect(browserEnvironmentRuntime.recordAgentBrowserStarted).toHaveBeenCalledOnce();
  });

  it.each([false, true])('keeps startup after approval for custom=%s and leaves denial unused', async (custom) => {
    const decision = deferred<ToolApprovalDecision>();
    const request = vi.fn(() => decision.promise);
    const { module } = await startModule();
    const tools = calls(module, { request });
    const running = tools.run(custom ? 'currentPage' : 'listPages', custom);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expectNoStartup();
    decision.resolve({ callId: 'sample-call', decision: 'deny' });
    expect(await running).toEqual({ ok: false, text: REJECT.approvalDenied() });
    expectNoStartup();
    request.mockResolvedValueOnce({ callId: 'sample-call', decision: 'allow' });
    expect(await tools.run(custom ? 'currentPage' : 'listPages', custom)).toMatchObject({ ok: true });
    expect(fingerprintBrowser.launch).toHaveBeenCalledOnce();
    expect(vi.mocked(fingerprintBrowser.launch).mock.invocationCallOrder[0]).toBeGreaterThan(request.mock.invocationCallOrder[1]);
  });

  it('preserves SDK validation and already-aborted signal checks before any connection', async () => {
    const { module } = await startModule();
    const runtime = sdk(module);
    await expect(runtime.page.navigate('file:///sample.txt')).rejects.toThrow('only supports HTTP(S)');
    await expect(runtime.selectPage(-1)).rejects.toThrow();
    await expect(runtime.page.press('')).rejects.toThrow('cannot be empty');
    const controller = new AbortController();
    const reason = new Error('Sample interruption');
    controller.abort(reason);
    await expect(sdk(module, controller.signal).page.currentPage()).rejects.toThrow('Browser Skill call was cancelled');
    expectNoStartup();
  });

  it('stops while planning and never launches when the plan completes late', async () => {
    const planning = deferred<BrowserLaunchSpec>();
    vi.mocked(browserEnvironmentRuntime.planLaunch).mockReturnValueOnce(planning.promise);
    const { module } = await startModule();
    const reading = module.core.listPages({ browserId: BROWSER_ID });
    const rejected = expect(reading).rejects.toThrow('terminated');
    await vi.waitFor(() => expect(browserEnvironmentRuntime.planLaunch).toHaveBeenCalledOnce());
    const signal = vi.mocked(browserEnvironmentRuntime.planLaunch).mock.calls[0][4]!;
    await module.onDestroyBegin();
    await rejected;
    expect(signal.aborted).toBe(true);
    planning.resolve(launchSpec);
    await Promise.resolve();
    expect(fingerprintBrowser.launch).not.toHaveBeenCalled();
    expect(puppeteer.connect).not.toHaveBeenCalled();
    expect(browserEnvironmentRuntime.recordAgentBrowserStarted).not.toHaveBeenCalled();
    expect(BrowserManager.ownedIds()).toEqual([]);
  });

  it('cleans a first launch stopped during connection and disconnects a late transport', async () => {
    const connecting = deferred<Awaited<ReturnType<typeof puppeteer.connect>>>();
    vi.mocked(puppeteer.connect).mockReturnValueOnce(connecting.promise);
    const { module } = await startModule();
    const reading = module.core.listPages({ browserId: BROWSER_ID });
    const rejected = expect(reading).rejects.toThrow('terminated');
    await vi.waitFor(() => expect(puppeteer.connect).toHaveBeenCalledOnce());
    await module.onDestroyBegin();
    await rejected;
    expect(fingerprintBrowser.stop).toHaveBeenCalledWith(PROFILE_ID);
    expect(fixture.automation.listPages).not.toHaveBeenCalled();
    expect(browserEnvironmentRuntime.recordAgentBrowserStarted).not.toHaveBeenCalled();
    expect(BrowserManager.ownedIds()).toEqual([]);
    connecting.resolve(fixture.browser as never);
    await vi.waitFor(() => expect(fixture.browser.disconnect).toHaveBeenCalledOnce());
  });

  it.each([false, true])('destroys an unused browser without creating a process, explicit close=%s', async (explicitClose) => {
    const { module } = await startModule();
    if (explicitClose) {
      expect(await calls(module).run('closeBrowser')).toMatchObject({ ok: true });
    }
    await module.onDestroyBegin();
    await module.onDestroy();
    expectNoStartup();
    expect(BrowserManager.ownedIds()).toEqual([]);
  });
});
