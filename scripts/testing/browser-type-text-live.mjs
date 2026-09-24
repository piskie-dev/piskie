#!/usr/bin/env node

// After npm run build:electron, run with PISKIE_BROWSER_LIVE=1 and optionally
// FP_CHROMIUM_PATH. TMPDIR controls the temporary profile and state directory.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable } from '../../dist-electron/electron/piskiepilot/browser/fingerprint/binary.js';
import { FingerprintBrowser } from '../../dist-electron/electron/piskiepilot/browser/fingerprint/manager.js';
import { BrowserManager } from '../../dist-electron/electron/piskiepilot/browser/core/browser/browser-manager.js';
import { createGeneratedBrowserSkillRuntime } from '../../dist-electron/electron/piskiepilot/browser/runtime/generated-skill-browser.js';
import { setPilotRoot } from '../../dist-electron/electron/piskiepilot/paths.js';
import { serveTextInputFixture, verifyTextInput } from './browser-type-text-fixture.mjs';

if (process.env.PISKIE_BROWSER_LIVE !== '1') {
  throw new Error('Set PISKIE_BROWSER_LIVE=1 to run the real Chromium text-input test.');
}

setPilotRoot(process.env.PISKIE_PILOT_ROOT ?? join(homedir(), '.piskie', 'piskiepilot'));
const executablePath = await resolveExecutable();
const profileRoot = await mkdtemp(join(tmpdir(), 'piskie-browser-type-text-live-'));
const pilotRoot = join(profileRoot, 'pilot-state');
setPilotRoot(pilotRoot);
const profileId = `type-text-live-${process.pid}`;
const browserId = `${profileId}-manager`;
const userDataDir = join(profileRoot, 'chrome-data');
const fingerprint = new FingerprintBrowser();
const server = createServer((request, response) => {
  if (serveTextInputFixture(request, response)) return;
  response.writeHead(404);
  response.end();
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const handle = await fingerprint.launch(profileId, { executablePath, headless: true, userDataDir });
  const browserConfigRoot = join(pilotRoot, 'browsers');
  await mkdir(browserConfigRoot, { recursive: true });
  await writeFile(join(browserConfigRoot, `${browserId}.json`), JSON.stringify({
    wsEndpoint: handle.browserWSEndpoint,
    userDataId: profileId,
    userDataDir,
    backgroundMode: false,
    pid: fingerprint.getPid(profileId),
  }));
  const generated = createGeneratedBrowserSkillRuntime({
    browserId,
    signal: new AbortController().signal,
    log: () => undefined,
    notifyPageOpen: () => undefined,
  });
  await verifyTextInput(browserId, generated, origin);
  const browserVersion = await BrowserManager.runExclusive(browserId, ({ browser }) => browser.version());
  process.stdout.write(`${JSON.stringify({
    browser: browserVersion,
    checks: [
      'core-and-sdk-type-text-selection-unicode-emoji',
      'core-snapshot-and-sdk-observation',
      'core-and-sdk-type-text-paragraphs-whitespace-empty',
      'contenteditable-trusted-input-events-and-application-state',
      'newline-enter-events',
      'typing-does-not-focus-an-unfocused-editor',
      'contenteditable-local-save-and-reload',
    ],
  }, null, 2)}\n`);
} finally {
  await BrowserManager.close(browserId).catch(() => undefined);
  await fingerprint.stop(profileId).catch(() => undefined);
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(profileRoot, { recursive: true, force: true });
}
