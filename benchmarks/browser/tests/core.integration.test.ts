import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserManager } from '../../../electron/piskiepilot/browser/core/browser/browser-manager.js';
import type { BrowserAutomationSession } from '../../../electron/piskiepilot/browser/core/session/browser-automation-session.js';
import { startFixtureServer } from '../fixture/server.mjs';
import { scenarios, SUITE_ID, SUITE_VERSION } from '../fixture/scenarios.mjs';
import { collectEnvironment } from '../runner/environment.mjs';
import { errorText, isTimeoutError, runCoreScenario, SourceTools, viewport } from '../runner/core.js';

vi.mock('electron', () => ({ app: {
  getPath: () => process.env.PISKIE_TEST_ARTIFACT_DIR,
  getAppPath: () => process.env.PISKIE_TEST_ARTIFACT_DIR,
} }));
vi.mock('../../../electron/piskiepilot/browser/core/browser/window-controller.js', () => ({
  WindowController: { initialize: async () => {} },
}));

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const browserId = 'browser-source-benchmark';
const records: Array<Record<string, unknown>> = [];
const consoleEvidencePolicy = process.env.PISKIE_BENCH_ALLOW_MISSING_CONSOLE === '1' ? 'optional' : 'required';

// Opt in with FP_CHROMIUM_PATH; this configuration never attaches to the desktop app.
describe.skipIf(!process.env.FP_CHROMIUM_PATH)('current source browser tools (FP_CHROMIUM_PATH required)', () => {
  let outputDir: string;
  let fixture: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
  let browser: Browser | undefined;
  let session: BrowserAutomationSession;
  let environment: Record<string, unknown>;
  let pid: number | undefined;

  beforeAll(async () => {
    const artifactRoot = process.env.PISKIE_TEST_ARTIFACT_DIR ?? tmpdir();
    await mkdir(artifactRoot, { recursive: true });
    outputDir = await mkdtemp(join(artifactRoot, 'browser-source-'));
    await mkdir(join(outputDir, 'records'));
    console.log(`Source browser benchmark artifacts: ${outputDir}`);
    fixture = await startFixtureServer({ seed: 1 });
    browser = await puppeteer.launch({
      executablePath: process.env.FP_CHROMIUM_PATH,
      headless: true,
      userDataDir: join(outputDir, 'profile'),
      defaultViewport: viewport,
      protocolTimeout: 20_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--site-per-process', '--disable-background-networking'],
    });
    pid = browser.process()?.pid;
    const manager = BrowserManager as unknown as {
      initialized: boolean;
      readPersistedBrowserConfig(id: string): Promise<unknown>;
      savePersisted(id: string, value: unknown): Promise<void>;
      deletePersisted(id: string): Promise<void>;
    };
    manager.initialized = true;
    vi.spyOn(manager, 'readPersistedBrowserConfig').mockImplementation(async (id) => {
      assert.equal(id, browserId);
      return { wsEndpoint: browser!.wsEndpoint() };
    });
    vi.spyOn(manager, 'savePersisted').mockResolvedValue(undefined);
    vi.spyOn(manager, 'deletePersisted').mockResolvedValue(undefined);
    session = await BrowserManager.getScreenSession(browserId);
    environment = {
      ...await collectEnvironment({
        workspace, runner: 'piskie-source-tools', runtimeLabel: 'source',
        browserExecutable: process.env.FP_CHROMIUM_PATH,
      }),
      browser: await browser.version(), viewport, consoleEvidencePolicy,
    };
  });

  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      assert(fixture);
      const run = fixture.createRun({ scenarioId: scenario.id, seed: 1 });
      const artifactDir = join(outputDir, `${scenario.id}-${run.runId}`);
      await mkdir(artifactDir, { recursive: true });
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new DOMException('Source benchmark scenario exceeded 150 seconds', 'TimeoutError')), 150_000);
      const ui = new SourceTools(session, browserId, artifactDir, controller.signal, consoleEvidencePolicy);
      const startedAt = new Date().toISOString();
      const start = performance.now();
      const errors: string[] = [];
      const artifactErrors: string[] = [];
      let timedOut = false;
      let result: { status: string; checks: unknown[]; completedAt: string | null } = {
        status: 'failed', checks: [], completedAt: null,
      };
      try {
        await runCoreScenario(ui, run);
      } catch (error) {
        timedOut = isTimeoutError(error);
        errors.push(errorText(error));
      } finally {
        clearTimeout(deadline);
        if (controller.signal.aborted && !errors.length) errors.push(errorText(controller.signal.reason));
        // Always ask the fixture's independent oracle, including after failed tool calls.
        try { result = fixture.evaluateRun(run.runId); }
        catch (error) { errors.push(`Oracle: ${errorText(error)}`); }
        if (result.status !== 'passed') errors.push(`Fixture oracle failed for ${scenario.id}; see result.checks`);
        // Freeze business timing and counts before evidence capture or resource cleanup.
        const record: Record<string, unknown> = {
          schemaVersion: 1, suite: { id: SUITE_ID, version: SUITE_VERSION },
          runId: run.runId, scenarioId: scenario.id, seed: 1, attempt: 1,
          variant: process.env.PISKIE_BENCH_VARIANT || 'working-tree', execution: 'scripted',
          startedAt, endedAt: new Date().toISOString(), wallTimeMs: performance.now() - start,
          termination: controller.signal.aborted || timedOut ? 'timeout' : errors.length ? 'failed' : 'completed',
          environment, requestedModel: null,
          ...ui.metrics(), result, artifactDir,
          ...(ui.capabilityNotes.length ? { capabilityNotes: structuredClone(ui.capabilityNotes) } : {}),
          ...(errors.length ? { error: errors.join('\n\n') } : {}),
        };
        records.push(record);
        try {
          if (!session.getDialog(ui.pageId) && !ui.page().isClosed()) {
            await ui.page().screenshot({ path: join(artifactDir, 'final.png') });
          }
        } catch (error) { record.captureError = errorText(error); }
        try { await ui.cleanup(run); }
        catch (error) { artifactErrors.push(`Cleanup: ${errorText(error)}`); }
        try { await ui.saveEvidence(); }
        catch (error) { artifactErrors.push(`Evidence: ${errorText(error)}`); }
        if (artifactErrors.length) record.artifactErrors = artifactErrors;
        // A raw record survives even if a later scenario or report generation fails.
        await writeFile(join(outputDir, 'records', `${run.runId}.json`), JSON.stringify(record, null, 2) + '\n');
      }
      expect(errors, `Scenario ${scenario.id}; evidence: ${artifactDir}`).toEqual([]);
      expect(artifactErrors, `Scenario cleanup/evidence: ${artifactDir}`).toEqual([]);
      expect(result.status).toBe('passed');
      expect(result.checks.length).toBeGreaterThan(0);
    });
  }

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      if (outputDir && records.length) {
        await writeFile(join(outputDir, 'records.json'), JSON.stringify(records, null, 2) + '\n');
        const { writeReport } = await import('../reporting/index.mjs');
        const reportOptions = { outputDir, baselineRecords: [] };
        const paths = await writeReport(records, reportOptions);
        console.log(`Source browser benchmark report: ${JSON.stringify(paths)}`);
      }
    } catch (error) { errors.push(error); }
    // These are our isolated Chromium and loopback fixture only, even after setup failure.
    try { await BrowserManager.close(browserId); } catch (error) { errors.push(error); }
    try { await browser?.close(); } catch (error) { errors.push(error); }
    try { await fixture?.close(); } catch (error) { errors.push(error); }
    let processExited = pid === undefined;
    if (pid !== undefined) {
      try {
        await vi.waitFor(() => {
          try { process.kill(pid!, 0); }
          catch { processExited = true; }
          expect(processExited).toBe(true);
        }, { timeout: 3_000, interval: 50 });
      } catch (error) { errors.push(error); }
    }
    const ownedIds = BrowserManager.ownedIds();
    if (ownedIds.includes(browserId)) errors.push(new Error('Source benchmark browser is still owned after cleanup'));
    vi.restoreAllMocks();
    if (outputDir) {
      await writeFile(join(outputDir, 'cleanup.json'), JSON.stringify({
        pid: pid ?? null, processExited, ownedIds, errors: errors.map(errorText),
      }, null, 2) + '\n');
    }
    if (errors.length) throw new AggregateError(errors, 'Source benchmark report or cleanup failed');
  });
});
