import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'puppeteer-core';
import type { AgentControlState, ConversationEntry } from '../../../../../../shared/types/agent-control.js';
import { AgentEngine, type TurnOutcome } from '../../../../../agent/agent-engine.js';
import type { TrustedBrowserSkillContext } from '../../../../core/skill/host.js';
import { BrowserManager } from '../browser-manager.js';
import { fingerprintBrowser } from '../../../fingerprint/runtime.js';
import skill from '../../../skills/browser/skill.js';
import * as core from '../../../skills/browser/index.js';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp' } }));

class BrowserStopEngine extends AgentEngine {
  released = false;
  cancelled = false;
  failure?: unknown;

  constructor(private readonly operation: (signal: AbortSignal) => Promise<unknown>) {
    super();
    this.id = 'browser-stop-test';
    this.mainAgentId = this.id;
    this.context = { flush: vi.fn(), getAllMessages: () => [] } as never;
  }

  start(): void { this.postSystemEvent('start'); }
  protected override async runTurn(signal: AbortSignal): Promise<TurnOutcome> {
    await this.operation(signal);
    return {};
  }
  protected override collectDestroyBeginTasks(): Promise<unknown>[] { return [BrowserManager.close('browser-a')]; }
  protected override async releaseResources(): Promise<void> { this.released = true; }
  protected override applyEvents(): void {}
  protected override handlePumpCancelled(): void { this.cancelled = true; }
  protected override handlePumpFailure(error: unknown): void { this.failure = error; }
  protected override appendConversationEntry(_entry: ConversationEntry): void {}
  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState { return { agentId: this.id, phase: this.phase } as AgentControlState; }
}

function context(signal: AbortSignal): TrustedBrowserSkillContext {
  return {
    browserId: 'browser-a', signal, log: vi.fn(),
    workspace: { dir: '/workspace', tempDir: '/workspace/tmp' },
    browser: { core, notifyPageOpen: vi.fn() } as unknown as TrustedBrowserSkillContext['browser'],
  };
}

// Opt in with an installed kernel executable; all browser data and HTTP traffic are local to this test.
describe.skipIf(!process.env.FP_CHROMIUM_PATH)('browser stop with a real managed process', () => {
  let root: string;
  let server: Server;
  let page: Page;
  let pid: number;
  let engine: BrowserStopEngine | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'browser-stop-'));
    server = createServer((request, response) => {
      if (request.url === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.write('data: {"state":"pending"}\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<html><body>Example<script>window.events = new EventSource("/events")</script></body></html>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const handle = await fingerprintBrowser.launch('profile-a', {
      executablePath: process.env.FP_CHROMIUM_PATH,
      userDataDir: join(root, 'profile'),
      headless: true,
      extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    pid = fingerprintBrowser.getPid('profile-a')!;
    const manager = BrowserManager as unknown as {
      initialized: boolean;
      readPersistedBrowserConfig(id: string): Promise<unknown>;
      savePersisted(id: string, config: unknown): Promise<void>;
      deletePersisted(id: string): Promise<void>;
    };
    manager.initialized = true;
    vi.spyOn(manager, 'readPersistedBrowserConfig').mockResolvedValue({
      wsEndpoint: handle.browserWSEndpoint, pid, userDataId: 'profile-a',
    });
    vi.spyOn(manager, 'savePersisted').mockResolvedValue(undefined);
    vi.spyOn(manager, 'deletePersisted').mockResolvedValue(undefined);
    await BrowserManager.getOrCreate('browser-a');
    page = await BrowserManager.getSelectedPage('browser-a');
    const address = server.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
  }, 20_000);

  afterEach(async () => {
    try {
      await engine?.destroy();
      await BrowserManager.closeAll();
    } finally {
      await fingerprintBrowser.stop('profile-a');
      server?.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (root) await rm(root, { recursive: true, force: true });
      engine = undefined;
      vi.restoreAllMocks();
    }
  });

  async function stopAndCheckProcess(): Promise<void> {
    const startedAt = Date.now();
    await engine!.destroy();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(engine!.released).toBe(true);
    expect(engine!.cancelled).toBe(true);
    expect(engine!.failure).toBeUndefined();
    expect(BrowserManager.ownedIds()).toEqual([]);
    expect(fingerprintBrowser.has('profile-a')).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  }

  it('destroys a runtime blocked on an unfinished event-stream response body', async () => {
    const request = await vi.waitFor(async () => {
      const found = await BrowserManager.runExclusive('browser-a', ({ automation }) =>
        automation.getNetworkRequests().find((item) => item.url().endsWith('/events') && item.response()));
      expect(found).toBeDefined();
      return found!;
    });
    const reqid = await BrowserManager.runExclusive('browser-a', ({ automation }) => automation.getNetworkRequestId(request));
    const buffer = vi.spyOn(request.response()!, 'buffer');
    let rawBodySettled = false;
    void request.response()!.buffer().then(() => { rawBodySettled = true; }, () => { rawBodySettled = true; });
    engine = new BrowserStopEngine((signal) => skill.functions.getNetworkRequest.run({ reqid }, context(signal)));
    engine.start();
    await vi.waitFor(() => expect(buffer).toHaveBeenCalledTimes(2));
    expect(rawBodySettled).toBe(false);
    await stopAndCheckProcess();
    expect(rawBodySettled).toBe(false);
  }, 15_000);

  it('destroys a runtime blocked on a page function that never returns', async () => {
    engine = new BrowserStopEngine((signal) => skill.functions.evaluateScript.run({
      function: '() => { window.pendingStopCheck = true; return new Promise(() => {}); }',
    }, context(signal)));
    engine.start();
    await page.waitForFunction('window.pendingStopCheck === true', { timeout: 5_000 });
    await stopAndCheckProcess();
  }, 15_000);
});
