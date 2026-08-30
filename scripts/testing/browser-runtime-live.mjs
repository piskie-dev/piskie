#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { FingerprintBrowser } from '../../dist-electron/electron/piskiepilot/browser/fingerprint/manager.js';
import { BrowserOperations } from '../../dist-electron/electron/piskiepilot/browser/core/browser/browser-operations.js';
import { BrowserManager } from '../../dist-electron/electron/piskiepilot/browser/core/browser/browser-manager.js';
import {
  BrowserAutomationSession,
  BrowserDialogOpenError,
} from '../../dist-electron/electron/piskiepilot/browser/core/session/browser-automation-session.js';
import { createGeneratedBrowserSkillRuntime } from '../../dist-electron/electron/piskiepilot/browser/runtime/generated-skill-browser.js';
import {
  clickByUid as clickBrowserCoreByUid,
  drag as dragBrowserCore,
  evaluateScript as evaluateBrowserCoreScript,
  getAllCookies as getBrowserCoreCookies,
  getConsoleMessage as getBrowserCoreConsoleMessage,
  getNetworkRequest as getBrowserCoreNetworkRequest,
  getWindowBounds as getBrowserCoreWindowBounds,
  handleDialog as handleBrowserCoreDialog,
  listConsoleMessages as listBrowserCoreConsoleMessages,
  listNetworkRequests as listBrowserCoreNetworkRequests,
  takeScreenshot as takeBrowserCoreScreenshot,
  uploadFile as uploadBrowserCoreFile,
  waitFor as waitForBrowserCore,
} from '../../dist-electron/electron/piskiepilot/browser/skills/browser/index.js';
import { setPilotRoot } from '../../dist-electron/electron/piskiepilot/paths.js';

if (process.env.PISKIE_BROWSER_LIVE !== '1') {
  throw new Error('Set PISKIE_BROWSER_LIVE=1 to run the real Fingerprint Chromium smoke test.');
}

setPilotRoot(process.env.PISKIE_PILOT_ROOT ?? join(homedir(), '.piskie', 'piskiepilot'));

const profileRoot = await mkdtemp(join(tmpdir(), 'piskie-browser-runtime-live-'));
const profileId = `runtime-live-${process.pid}`;
const managerBrowserId = `${profileId}-manager`;
const workspaceRoot = join(profileRoot, 'workspace');
const workspaceTempRoot = join(workspaceRoot, '.tmp');
const uploadFixturePath = join(workspaceTempRoot, 'runtime-upload.txt');
const fingerprint = new FingerprintBrowser();
const server = createServer((request, response) => {
  if (request.url?.startsWith('/api/runtime')) {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'x-runtime-response': 'observed',
    });
    response.end(JSON.stringify({ received: true }));
    return;
  }
  if (request.url?.startsWith('/slow-target')) {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Slow target</title><p>arrived</p>');
    }, 250);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
    <html><head><title>Runtime fixture</title></head><body>
      <label>Name <input aria-label="Name" /></label>
      <label>Cabin <select aria-label="Cabin"><option value="economy">Economy</option><option value="business">Business</option></select></label>
      <label><input type="checkbox" aria-label="Direct" /> Direct</label>
      <button id="continue" onclick="document.querySelector('#status').textContent='ready'; history.pushState(null, '', '/fixture?state=ready')">Continue</button>
      <button id="slow-navigation" onclick="location.href='/slow-target'">Slow navigation</button>
      <button id="duplicate" onclick="window.open(location.href, '_blank')">Open duplicate</button>
      <button id="alert" onclick="alert('Heads up')">Open alert</button>
      <button id="confirm" onclick="document.querySelector('#status').textContent=confirm('Continue?')?'confirmed':'cancelled'">Open confirm</button>
      <button id="dialog" onclick="document.querySelector('#status').textContent=prompt('Passenger name?', 'Ada')??'prompt-dismissed'">Open prompt</button>
      <div id="drag-source" role="button" aria-label="Drag source" draggable="true">Drag source</div>
      <div id="drop-target" role="button" aria-label="Drop target" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.querySelector('#status').textContent='dropped'">Drop target</div>
      <label>Direct upload <input id="direct-file" type="file" aria-label="Direct upload" onchange="document.querySelector('#status').textContent='direct:'+this.files[0].name" /></label>
      <input id="proxy-file" type="file" hidden onchange="document.querySelector('#status').textContent='proxy:'+this.files[0].name" />
      <button id="proxy-upload" onclick="document.querySelector('#proxy-file').click()">Proxy upload</button>
      <p id="delayed">waiting</p>
      <p id="status">idle</p>
    </body></html>`);
});

let browser;
let browserVersion;
let session;
try {
  const origin = await listen(server);
  await mkdir(workspaceTempRoot, { recursive: true });
  await writeFile(uploadFixturePath, 'browser upload fixture\n');
  const handle = await fingerprint.launch(profileId, {
    headless: true,
    userDataDir: join(profileRoot, 'chrome-data'),
  });
  browser = await puppeteer.connect({
    browserWSEndpoint: handle.browserWSEndpoint,
    defaultViewport: null,
    protocolTimeout: 0,
  });
  browserVersion = await browser.version();
  session = await BrowserAutomationSession.create(browser);
  const navigation = await BrowserOperations.navigateInSession(session, {
    type: 'url',
    url: `${origin}/fixture`,
    timeout: 15_000,
  });
  assert.equal(navigation.url, `${origin}/fixture`);
  assert.equal(navigation.title, 'Runtime fixture');
  mark('navigation');

  const snapshot = await session.takeSnapshot(true);
  const name = findNode(snapshot.root, 'textbox', 'Name');
  const cabin = findNode(snapshot.root, 'combobox', 'Cabin');
  const direct = findNode(snapshot.root, 'checkbox', 'Direct');
  const continueButton = findNode(snapshot.root, 'button', 'Continue');
  await session.fillFormByUids([
    { uid: name.id, value: 'Ada Lovelace' },
    { uid: cabin.id, value: 'Business' },
    { uid: direct.id, value: 'true' },
  ]);
  await session.clickByUid(continueButton.id, 1);
  assert.deepEqual(
    await session.getSelectedPage().evaluate(() => ({
      name: document.querySelector('input[aria-label="Name"]').value,
      cabin: document.querySelector('select').value,
      direct: document.querySelector('input[aria-label="Direct"]').checked,
      status: document.querySelector('#status').textContent,
    })),
    { name: 'Ada Lovelace', cabin: 'business', direct: true, status: 'ready' }
  );
  assert.equal(session.getSelectedPage().url(), `${origin}/fixture?state=ready`);
  mark('form-actions');

  const replacement = await session.takeSnapshot();
  await assert.rejects(session.getElementByUid(snapshot.root.id), /stale snapshot/i);
  const alertButton = findNode(replacement.root, 'button', 'Open alert');
  const confirmButton = findNode(replacement.root, 'button', 'Open confirm');
  const promptButton = findNode(replacement.root, 'button', 'Open prompt');
  await observeAndHandleDialog(session, alertButton.id, 'alert', 'accept');
  await observeAndHandleDialog(session, confirmButton.id, 'confirm', 'dismiss');
  assert.equal(await session.getSelectedPage().evaluate(() => document.querySelector('#status').textContent), 'cancelled');
  await observeAndHandleDialog(session, promptButton.id, 'prompt', 'accept', 'Grace');
  assert.equal(await session.getSelectedPage().evaluate(() => document.querySelector('#status').textContent), 'Grace');
  mark('dialog-observed');
  mark('dialog-handled');

  const duplicateButton = findNode(replacement.root, 'button', 'Open duplicate');
  await session.clickByUid(duplicateButton.id, 1);
  const duplicatePages = await session.listPages();
  assert.equal(
    duplicatePages.filter((entry) => entry.page.url() === `${origin}/fixture?state=ready`).length,
    2
  );
  assert.equal(new Set(duplicatePages.map((entry) => entry.pageId)).size, duplicatePages.length);
  await session.closePageByIndex(1);
  mark('duplicate-tab');

  const navigationSnapshot = await session.takeSnapshot();
  const slowNavigationButton = findNode(
    navigationSnapshot.root,
    'button',
    'Slow navigation'
  );
  await session.clickByUid(slowNavigationButton.id, 1);
  assert.equal(session.getSelectedPage().url(), `${origin}/slow-target`);
  assert.equal(await session.getSelectedPage().title(), 'Slow target');
  mark('slow-click-navigation');
  await BrowserOperations.navigateInSession(session, {
    type: 'url',
    url: `${origin}/fixture?state=ready`,
    timeout: 15_000,
  });

  const screenshot = await session.getSelectedPage().screenshot({ type: 'png' });
  assert.ok(screenshot.byteLength > 100);
  assert.equal(await session.getSelectedPage().evaluate(() => document.title), 'Runtime fixture');
  mark('screenshot-evaluate');

  const client = await session.getSelectedPage().createCDPSession();
  try {
    await client.send('Network.enable');
    await client.send('Network.setCookie', {
      name: 'runtime-smoke',
      value: 'ok',
      url: `${origin}/fixture`,
    });
    const cookies = await client.send('Network.getAllCookies');
    assert.ok(cookies.cookies.some((cookie) => cookie.name === 'runtime-smoke'));
  } finally {
    await client.detach();
  }
  mark('cookies');

  const oldPageId = session.getSelectedPageId();
  const oldUid = replacement.root.id;
  session.dispose();
  await browser.disconnect();
  mark('disconnected');
  browser = await puppeteer.connect({
    browserWSEndpoint: handle.browserWSEndpoint,
    defaultViewport: null,
    protocolTimeout: 0,
  });
  session = await BrowserAutomationSession.create(browser);
  assert.ok(session.getSelectedPageId() > oldPageId);
  await assert.rejects(session.getElementByUid(oldUid), /No snapshot found/);
  mark('reconnected');

  session.dispose();
  session = undefined;
  await browser.disconnect();
  browser = undefined;

  const isolatedPilotRoot = join(profileRoot, 'pilot-state');
  setPilotRoot(isolatedPilotRoot);
  const browserConfigRoot = join(isolatedPilotRoot, 'browsers');
  await mkdir(browserConfigRoot, { recursive: true });
  await writeFile(join(browserConfigRoot, `${managerBrowserId}.json`), JSON.stringify({
    wsEndpoint: handle.browserWSEndpoint,
    userDataId: profileId,
    userDataDir: join(profileRoot, 'chrome-data'),
    backgroundMode: false,
    pid: fingerprint.getPid(profileId),
  }));
  await BrowserManager.getOrCreate(managerBrowserId);

  assert.match(
    await evaluateBrowserCoreScript({
      browserId: managerBrowserId,
      function: '() => document.title',
    }),
    /Runtime fixture/
  );
  assert.match(
    await takeBrowserCoreScreenshot({ browserId: managerBrowserId }),
    /Took a screenshot of the current page's viewport\./
  );
  const coreCookies = JSON.parse(await getBrowserCoreCookies({ browserId: managerBrowserId }));
  assert.ok(coreCookies.cookies.some((cookie) => cookie.name === 'runtime-smoke'));
  const coreBounds = JSON.parse(await getBrowserCoreWindowBounds({ browserId: managerBrowserId }));
  assert.equal(coreBounds.success, true);
  assert.equal(typeof coreBounds.bounds, 'object');
  mark('browser-adapter');

  await BrowserManager.runExclusive(managerBrowserId, async ({ automation }) => {
    await automation.getSelectedPage().evaluate(() => {
      const delayed = document.querySelector('#delayed');
      if (!delayed) throw new Error('Missing delayed-text fixture');
      delayed.textContent = 'waiting';
      setTimeout(() => {
        delayed.textContent = 'delayed-ready';
      }, 350);
    });
  });
  assert.match(await waitForBrowserCore({
    browserId: managerBrowserId,
    text: ['never-present', 'delayed-ready'],
    timeout: 3_000,
  }), /Element matching one of \["never-present","delayed-ready"\] found\./);
  mark('browser-wait');

  const dragUids = await BrowserManager.runExclusive(
    managerBrowserId,
    async ({ automation }) => {
      const current = await automation.takeSnapshot();
      return {
        fromUid: findNode(current.root, 'button', 'Drag source').id,
        toUid: findNode(current.root, 'button', 'Drop target').id,
      };
    }
  );
  assert.match(await dragBrowserCore({
    browserId: managerBrowserId,
    ...dragUids,
  }), /Successfully dragged an element/);
  assert.equal(await readManagedStatus(managerBrowserId), 'dropped');
  mark('browser-drag');

  const directUploadUid = await getManagedNodeUid(managerBrowserId, 'button', 'Direct upload');
  assert.match(await uploadBrowserCoreFile({
    browserId: managerBrowserId,
    uid: directUploadUid,
    filePath: uploadFixturePath,
    allowedRoots: [workspaceRoot, workspaceTempRoot],
  }), /File uploaded from .*runtime-upload\.txt\./);
  assert.equal(await readManagedStatus(managerBrowserId), 'direct:runtime-upload.txt');

  const proxyUploadUid = await getManagedNodeUid(managerBrowserId, 'button', 'Proxy upload');
  assert.match(await uploadBrowserCoreFile({
    browserId: managerBrowserId,
    uid: proxyUploadUid,
    filePath: uploadFixturePath,
    allowedRoots: [workspaceRoot, workspaceTempRoot],
  }), /File uploaded from .*runtime-upload\.txt\./);
  assert.equal(await readManagedStatus(managerBrowserId), 'proxy:runtime-upload.txt');
  mark('browser-upload');

  await openAndHandleBrowserCoreDialog(managerBrowserId, 'Open alert', 'accept');
  await openAndHandleBrowserCoreDialog(managerBrowserId, 'Open confirm', 'dismiss');
  assert.equal(await readManagedStatus(managerBrowserId), 'cancelled');
  await openAndHandleBrowserCoreDialog(
    managerBrowserId,
    'Open prompt',
    'accept',
    'Grace Hopper'
  );
  assert.equal(await readManagedStatus(managerBrowserId), 'Grace Hopper');
  mark('browser-dialog');

  assert.match(await evaluateBrowserCoreScript({
    browserId: managerBrowserId,
    function: `async () => {
      console.error('runtime-console', { code: 418 });
      const response = await fetch('${origin}/api/runtime', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-runtime-request': 'observed',
        },
        body: 'runtime-request',
      });
      return response.json();
    }`,
  }), /"received":true/);

  const networkLine = await waitForObservationLine(
    () => listBrowserCoreNetworkRequests({
      browserId: managerBrowserId,
      resourceTypes: ['fetch'],
    }),
    (line) => line.includes('/api/runtime'),
    'Network observation',
  );
  const requestId = parseStableId(networkLine, 'reqid');
  const networkDetail = await getBrowserCoreNetworkRequest({
    browserId: managerBrowserId,
    reqid: requestId,
  });
  assert.match(networkDetail, /Status: 200/);
  assert.match(networkDetail, /x-runtime-request:observed/);
  assert.match(networkDetail, /runtime-request/);
  assert.match(networkDetail, /x-runtime-response:observed/);
  assert.match(networkDetail, /\{"received":true\}/);
  mark('browser-network');

  const consoleLine = await waitForObservationLine(
    () => listBrowserCoreConsoleMessages({
      browserId: managerBrowserId,
      types: ['error'],
    }),
    (line) => line.includes('runtime-console'),
    'Console observation',
  );
  const consoleId = parseStableId(consoleLine, 'msgid');
  const consoleDetail = await getBrowserCoreConsoleMessage({
    browserId: managerBrowserId,
    msgid: consoleId,
  });
  assert.match(consoleDetail, /Message: error> runtime-console/);
  assert.match(consoleDetail, /\{"code":418\}/);
  mark('browser-console');

  const stableSnapshotId = await BrowserManager.runExclusive(
    managerBrowserId,
    async ({ automation }) => (await automation.takeSnapshot()).snapshotId
  );
  const generated = createGeneratedBrowserSkillRuntime({
    browserId: managerBrowserId,
    signal: new AbortController().signal,
    log: () => undefined,
    notifyPageOpen: () => undefined,
  });
  await generated.page.fill({ label: 'Name' }, 'Katherine Johnson');
  await generated.page.select({ label: 'Cabin' }, 'economy');
  await generated.page.hover({ role: 'button', name: 'Continue' });
  assert.equal(
    await generated.page.extractText({ locator: { label: 'Name' }, attribute: 'aria-label' }),
    'Name'
  );
  assert.deepEqual(await generated.page.extractList({
    items: { css: 'select option' },
    fields: {
      display: { text: 'self' },
      value: { attribute: 'value' },
    },
    state: 'attached',
  }), [
    { display: 'Economy', value: 'economy' },
    { display: 'Business', value: 'business' },
  ]);
  await BrowserManager.runExclusive(managerBrowserId, async ({ automation }) => {
    assert.equal(automation.getActiveSnapshot()?.snapshotId, stableSnapshotId);
    assert.deepEqual(await automation.getSelectedPage().evaluate(() => ({
      name: document.querySelector('input[aria-label="Name"]').value,
      cabin: document.querySelector('select').value,
    })), {
      name: 'Katherine Johnson',
      cabin: 'economy',
    });
  });
  await generated.page.click({ role: 'button', name: 'Continue' });
  await generated.page.waitFor({ text: 'ready' });
  assert.equal((await generated.listPages()).length, 1);
  mark('generated-skill');

  const managerGeneration = await BrowserManager.runExclusive(
    managerBrowserId,
    async ({ automation, browser: managedBrowser }) => {
      const snapshot = await automation.takeSnapshot();
      const state = {
        pageId: automation.getSelectedPageId(),
        uid: snapshot.root.id,
      };
      managedBrowser.disconnect();
      return state;
    }
  );
  await BrowserManager.runExclusive(managerBrowserId, async ({ automation }) => {
    assert.ok(automation.getSelectedPageId() > managerGeneration.pageId);
    await assert.rejects(automation.getElementByUid(managerGeneration.uid), /No snapshot found/);
  });
  mark('manager-recovery');

  const finalPageCount = await BrowserManager.runExclusive(
    managerBrowserId,
    async ({ automation }) => (await automation.listPages()).length
  );

  process.stdout.write(`${JSON.stringify({
    browser: browserVersion,
    puppeteerCore: '25.9.0',
    pages: finalPageCount,
    checks: [
      'navigate',
      'snapshot',
      'fill-text',
      'select',
      'toggle',
      'spa-update',
      'slow-click-navigation',
      'uid-staleness',
      'duplicate-url-tabs',
      'alert-confirm-prompt',
      'screenshot',
      'evaluate',
      'cookies',
      'browser-adapter',
      'browser-wait',
      'browser-drag',
      'browser-upload-direct-and-chooser',
      'browser-dialog-accept-dismiss-prompt',
      'browser-console-list-and-get',
      'browser-network-list-and-get',
      'disconnect-reconnect',
      'generated-skill-stable-locator',
      'browser-manager-recovery',
    ],
  }, null, 2)}\n`);
} finally {
  await BrowserManager.close(managerBrowserId).catch(() => undefined);
  session?.dispose();
  await browser?.disconnect().catch(() => undefined);
  await fingerprint.stop(profileId).catch(() => undefined);
  await close(server);
  await rm(profileRoot, { recursive: true, force: true });
}

function findNode(root, role, name) {
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.role?.toLowerCase() === role.toLowerCase() && node.name === name) return node;
    queue.push(...node.children);
  }
  throw new Error(`Accessibility node not found: ${role} ${JSON.stringify(name)}`);
}

function mark(check) {
  process.stderr.write(`[browser-runtime-live] ${check}\n`);
}

async function getManagedNodeUid(browserId, role, name) {
  return BrowserManager.runExclusive(browserId, async ({ automation }) => {
    const snapshot = await automation.takeSnapshot();
    return findNode(snapshot.root, role, name).id;
  });
}

async function readManagedStatus(browserId) {
  return BrowserManager.runExclusive(browserId, async ({ automation }) => {
    return automation.getSelectedPage().evaluate(() => {
      return document.querySelector('#status')?.textContent;
    });
  });
}

async function openAndHandleBrowserCoreDialog(browserId, buttonName, action, promptText) {
  const uid = await getManagedNodeUid(browserId, 'button', buttonName);
  await assert.rejects(clickBrowserCoreByUid({ browserId, uid }), (error) => {
    assert.ok(error instanceof BrowserDialogOpenError);
    return true;
  });
  const output = await handleBrowserCoreDialog({ browserId, action, promptText });
  assert.match(
    output,
    action === 'accept'
      ? /Successfully accepted the dialog/
      : /Successfully dismissed the dialog/
  );
}

function parseStableId(line, label) {
  const match = line.match(new RegExp(`${label}=(\\d+)`));
  assert.ok(match, `Missing ${label} in: ${line}`);
  return Number(match[1]);
}

async function waitForObservationLine(read, predicate, label) {
  const deadline = Date.now() + 3_000;
  let output = '';
  do {
    output = await read();
    const line = output.split('\n').find(predicate);
    if (line) return line;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label} missing from:\n${output}`);
}

async function observeAndHandleDialog(browserSession, uid, type, action, promptText) {
  await assert.rejects(browserSession.clickByUid(uid, 1), (error) => {
    assert.ok(error instanceof BrowserDialogOpenError);
    assert.equal(error.dialog.type, type);
    return true;
  });
  await browserSession.handleDialog(action, promptText);
}

function listen(httpServer) {
  return new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', rejectPromise);
      const address = httpServer.address();
      if (!address || typeof address === 'string') {
        rejectPromise(new Error('Local fixture server did not expose a TCP port'));
        return;
      }
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(httpServer) {
  if (!httpServer.listening) return Promise.resolve();
  return new Promise((resolvePromise) => httpServer.close(() => resolvePromise()));
}
