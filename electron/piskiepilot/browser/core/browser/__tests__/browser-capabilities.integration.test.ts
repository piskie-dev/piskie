import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserManager } from '../browser-manager.js';
import type { BrowserAutomationSession } from '../../session/browser-automation-session.js';
import { getDevToolsData } from '../../session/devtools-reader.js';
import type { TrustedBrowserSkillContext } from '../../../../core/skill/host.js';
import * as core from '../../../skills/browser/index.js';
import skill from '../../../skills/browser/skill.js';
import { sampleCapabilitiesHtml, sampleFrameHtml, sampleMappedScript, sampleMappedSourceMap } from './browser-capabilities.fixture.js';

vi.mock('electron', () => ({ app: { getPath: () => process.env.PISKIE_TEST_ARTIFACT_DIR, getAppPath: () => process.env.PISKIE_TEST_ARTIFACT_DIR } }));
vi.mock('../window-controller.js', () => ({ WindowController: { initialize: async () => {} } }));
const browserId = 'sample-capability-browser';

// Every case uses actual wrappers, exclusive manager, session, collectors and Chrome.
// Electron layout and persisted connection lookup are the only substituted host boundaries.
describe.skipIf(!process.env.FP_CHROMIUM_PATH)('real Chromium 22 capability acceptance and separate task chains', () => {
  let root: string;
  let baseUrl: string;
  let server: Server;
  let browser: Browser;
  let session: BrowserAutomationSession;
  let page: Page;
  let pageId: number;
  let pid: number;
  const evidence: Record<string, unknown> = {};

  function target(id = pageId) {
    return { browserId, pageId: id, files: { cwd: root, tempDir: root, allowedRoots: [root] } };
  }
  function uid(name: string, id = pageId) {
    const nodes = [...session.getActiveSnapshot(id)!.idToNode.values()].filter(item => item.name === name);
    const node = nodes.find(item => ['textbox', 'button', 'checkbox', 'combobox', 'link', 'option'].includes(item.role)) ?? nodes[0];
    expect(node, `Current snapshot contains ${name}`).toBeDefined();
    return node!.id;
  }
  async function observe(id = pageId) { return core.take_snapshot(target(id)); }
  async function values() { return page.$$eval('#sample-form input', elements => elements.map(element => (element as HTMLInputElement).value)); }
  async function state() { return page.evaluate(() => (window as unknown as { sampleState: Record<string, unknown> }).sampleState); }
  function toolContext(): TrustedBrowserSkillContext {
    return { browserId, signal: new AbortController().signal, workspace: { dir: root, tempDir: root }, log: () => {},
      browser: { core, notifyPageOpen: () => {} } } as unknown as TrustedBrowserSkillContext;
  }
  async function traffic() {
    await page.evaluate(async () => {
      console.log('Sample repeated message'); console.log('Sample repeated message'); console.warn('Sample warning');
      await fetch('/sample-body', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Sample-Header': 'Sample public header' }, body: 'Sample request body' }).then(response => response.text());
      await fetch('/sample-large-body').then(response => response.text());
    });
    await vi.waitFor(() => expect(session.getNetworkRequests(false, pageId).some(request => request.url().endsWith('/sample-body') && request.response())).toBe(true));
  }
  function requestId(suffix: string) {
    const collector = session.getNetworkCollector(pageId);
    const request = collector.getData().find(item => item.url().endsWith(suffix));
    expect(request).toBeDefined();
    return collector.getIdForResource(request!);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(process.env.PISKIE_TEST_ARTIFACT_DIR ?? tmpdir(), 'sample-capabilities-'));
    server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://sample.test').pathname;
      if (pathname === '/sample-frame') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(sampleFrameHtml(request.url?.includes('cross') ? 'Sample cross' : 'Sample iframe')); }
      else if (pathname === '/sample-mapped.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(sampleMappedScript); }
      else if (pathname === '/sample-mapped.js.map') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(sampleMappedSourceMap); }
      else if (pathname === '/sample-body') { let body = ''; for await (const chunk of request) body += chunk; response.writeHead(200, { 'Content-Type': 'text/plain', 'X-Sample-Response': 'Sample public response' }); response.end(`Sample response body: ${body}`); }
      else if (pathname === '/sample-large-body') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('Sample large response '.repeat(650)); }
      else if (pathname === '/sample-cors') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('Sample CORS body'); }
      else if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); }
      else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(sampleCapabilitiesHtml(baseUrl, pathname === '/sample-next' ? 'Sample next page' : 'Sample page')); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(join(root, 'sample-page.html'), sampleCapabilitiesHtml(baseUrl));
    await writeFile(join(root, 'sample-frame.html'), sampleFrameHtml());
    browser = await puppeteer.launch({ executablePath: process.env.FP_CHROMIUM_PATH, headless: true, userDataDir: join(root, 'sample-profile'),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--site-per-process', '--disable-background-networking'] });
    pid = browser.process()!.pid!;
    const manager = BrowserManager as unknown as { initialized: boolean; readPersistedBrowserConfig(id: string): Promise<unknown>; savePersisted(id: string, value: unknown): Promise<void>; deletePersisted(id: string): Promise<void> };
    manager.initialized = true;
    vi.spyOn(manager, 'readPersistedBrowserConfig').mockResolvedValue({ wsEndpoint: browser.wsEndpoint() });
    vi.spyOn(manager, 'savePersisted').mockResolvedValue(undefined);
    vi.spyOn(manager, 'deletePersisted').mockResolvedValue(undefined);
    session = await BrowserManager.getScreenSession(browserId);
    page = session.getSelectedPage();
    pageId = session.getSelectedPageId();
    evidence.environment = { version: await browser.version(), pid, baseUrl, root, headless: true };
  }, 30_000);

  beforeEach(async () => {
    for (const item of await session.listPages()) if (item.page !== page) await item.page.close();
    await session.listPages();
    await session.selectPageById(pageId);
    await page.setViewport({ width: 1100, height: 1000 });
    await page.goto(`${baseUrl}/sample`, { waitUntil: 'load' });
  });
  afterEach(async context => {
    if (session.getDialog(pageId)) await session.handleDialog('dismiss', undefined, pageId);
    if (!page.isClosed()) {
      const filename = context.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 100);
      await page.screenshot({ path: join(root, `${filename}.png`) });
    }
    vi.clearAllMocks();
  });
  afterAll(async () => {
    try { await BrowserManager.closeAll(); await browser?.close(); }
    finally {
      server?.closeAllConnections();
      if (server) await new Promise<void>(resolve => server.close(() => resolve()));
      let processExited = false;
      try { process.kill(pid, 0); } catch { processExited = true; }
      evidence.cleanup = { pid, processExited, serverListening: server?.listening, ownedIds: BrowserManager.ownedIds() };
      if (root) await writeFile(join(root, 'capability-evidence.json'), JSON.stringify(evidence, null, 2));
      expect(processExited).toBe(true);
      expect(BrowserManager.ownedIds()).toEqual([]);
      vi.restoreAllMocks();
    }
  }, 15_000);

  it('capability list_pages reports actual stable registered IDs', async () => {
    const result = await core.list_pages({ browserId });
    expect(result).toContain('## Pages'); expect(result).toContain(`${pageId}:`); expect(result).toContain('[selected]'); expect(result).toContain(baseUrl);
  });
  it('capability new_page selects background pages and reuses named contexts', async () => {
    await core.new_page({ browserId, url: `${baseUrl}/sample-next`, background: true, isolatedContext: 'sample-context' });
    const first = session.getSelectedPage(); const firstId = session.getSelectedPageId();
    await first.evaluate(() => localStorage.setItem('sample-key', 'Sample context value'));
    const result = await core.new_page({ browserId, url: `${baseUrl}/sample`, background: true, isolatedContext: 'sample-context' });
    const second = session.getSelectedPage();
    expect(second.browserContext()).toBe(first.browserContext()); expect(second.browserContext()).not.toBe(page.browserContext());
    expect(await second.evaluate(() => localStorage.getItem('sample-key'))).toBe('Sample context value');
    expect(result).toContain('sample-context'); expect((await session.listPages()).find(item => item.page === first)?.pageId).toBe(firstId);
  }, 15_000);
  it('capability select_page preserves SDK-independent IDs and explicit front behavior', async () => {
    await core.new_page({ browserId, url: `${baseUrl}/sample-next` });
    const front = vi.spyOn(page, 'bringToFront');
    try {
      await core.select_page(target()); expect(session.getSelectedPage()).toBe(page); expect(front).not.toHaveBeenCalled();
      await core.select_page({ ...target(), bringToFront: true }); expect(front).toHaveBeenCalledOnce();
    } finally { front.mockRestore(); }
  });
  it('capability close_page closes the ID and refuses the actual last page', async () => {
    await core.new_page({ browserId, url: `${baseUrl}/sample-next` }); const closed = session.getSelectedPage(); const id = session.getSelectedPageId();
    await core.close_page(target(id)); expect(closed.isClosed()).toBe(true); expect((await session.listPages()).map(item => item.pageId)).toEqual([pageId]);
    expect(await core.close_page(target())).toContain('The last open page cannot be closed.'); expect(page.isClosed()).toBe(false);
  });
  it('capability navigate_page handles URL history reload and scoped initScript with stable ID', async () => {
    expect(await core.navigate_page({ ...target(), url: `${baseUrl}/sample-next`, initScript: "window.sampleInit = 'Sample init';" })).toContain('Successfully navigated');
    expect(await page.evaluate(() => (window as unknown as { sampleInit: string }).sampleInit)).toBe('Sample init');
    expect(session.getSelectedPageId()).toBe(pageId);
    await core.navigate_page({ ...target(), type: 'back' }); expect(page.url()).toBe(`${baseUrl}/sample`);
    await core.navigate_page({ ...target(), type: 'forward' }); expect(page.url()).toBe(`${baseUrl}/sample-next`);
    await core.navigate_page({ ...target(), type: 'reload', ignoreCache: true });
    expect(await page.evaluate(() => 'sampleInit' in window)).toBe(false);
  }, 15_000);
  it('capability take_snapshot returns AX values, stable UIDs and a real text file', async () => {
    const first = await observe(); const before = uid('Sample field 01');
    expect(first).toContain('uid='); expect(first).toContain('textbox "Sample field 01"');
    await observe(); expect(uid('Sample field 01')).toBe(before);
    const result = await core.take_snapshot({ ...target(), verbose: true, filePath: 'sample-observation.out' });
    expect(result).toContain(join(root, 'sample-observation.txt')); expect(await readFile(join(root, 'sample-observation.txt'), 'utf8')).toContain('Sample field 01');
  });
  it('capability click performs single and double native clicks', async () => {
    await observe(); const id = uid('Sample click');
    expect(await core.click({ ...target(), uid: id })).toContain('Successfully clicked');
    expect(await core.click({ ...target(), uid: id, dblClick: true })).toContain('Successfully double clicked');
    expect((await state()).clicks).toBe(3);
  });
  it('capability hover reaches the actual element', async () => {
    await observe(); expect(await core.hover({ ...target(), uid: uid('Sample hover') })).toContain('Successfully hovered');
    expect((await state()).hovers).toBeGreaterThan(0);
  });
  it('capability fill supports text select and toggle through shared input', async () => {
    await observe(); await core.fill({ ...target(), uid: uid('Sample field 01'), value: 'Sample text' });
    await core.fill({ ...target(), uid: uid('Sample select'), value: 'Sample two' });
    await core.fill({ ...target(), uid: uid('Sample toggle'), value: 'true' });
    expect((await values())[0]).toBe('Sample text'); expect(await page.$eval('select', element => element.value)).toBe('two');
    expect(await page.$eval('#sample-toggle', element => (element as HTMLInputElement).checked)).toBe(true);
  });
  it('capability fill_form writes ten actual fields under one outer wait without hidden AX', async () => {
    await observe(); const snapshot = session.getActiveSnapshot(pageId); const wait = vi.spyOn(session, 'waitForAction'); const ax = vi.spyOn(page.accessibility, 'snapshot');
    const expected = Array.from({ length: 10 }, (_, index) => `Sample value ${index + 1}`);
    try {
      const elements = expected.map((value, index) => ({ uid: uid(`Sample field ${String(index + 1).padStart(2, '0')}`), value }));
      expect(await core.fill_form({ ...target(), elements })).toContain('Successfully filled out the form');
      expect(await values()).toEqual(expected); expect(wait).toHaveBeenCalledOnce(); expect(ax).not.toHaveBeenCalled(); expect(session.getActiveSnapshot(pageId)).toBe(snapshot);
      const inputEvents = (await state()).fieldOrder as string[];
      expect(inputEvents.filter((field, index) => field !== inputEvents[index - 1])).toEqual(expected.map((_, index) => `field-${String(index + 1).padStart(2, '0')}`));
      evidence.tenFieldCapability = { expected, inputEvents, outerWaits: wait.mock.calls.length, axCalls: ax.mock.calls.length };
    } finally { wait.mockRestore(); ax.mockRestore(); }
  });
  it('capability type_text submits the real focused form with submitKey and no AX', async () => {
    await page.focus('#sample-type'); const ax = vi.spyOn(page.accessibility, 'snapshot');
    try { expect(await core.type_text({ ...target(), text: 'Sample typed value', submitKey: 'Enter' })).toContain(' + Enter'); expect((await state()).typed).toEqual(['Sample typed value']); expect(ax).not.toHaveBeenCalled(); }
    finally { ax.mockRestore(); }
  });
  it('capability press_key replaces a selection and releases modifiers', async () => {
    await page.focus('#sample-type'); await page.keyboard.type('Sample previous');
    await core.press_key({ ...target(), key: 'Control+A' }); await core.type_text({ ...target(), text: 'Sample replacement' });
    await core.press_key({ ...target(), key: 'x' });
    expect(await page.$eval('#sample-type', element => (element as HTMLInputElement).value)).toBe('Sample replacementx');
    expect(((await state()).keys as Array<{ key: string; ctrl: boolean }>).at(-1)).toMatchObject({ key: 'x', ctrl: false });
  });
  it('capability drag changes actual DOM outcome with pressed mouse movement', async () => {
    await observe(); expect(await core.drag({ ...target(), from_uid: uid('Sample drag'), to_uid: uid('Sample drop') })).toContain('Successfully dragged');
    expect((await state()).drop).toBe(1); expect(await page.$eval('#sample-drag-result', element => element.textContent)).toBe('Sample drop complete');
  });
  it('capability upload_file uploads multiple real files without an outer wait', async () => {
    await observe(); const filePaths = [join(root, 'sample-one.txt'), join(root, 'sample-two.txt')]; await Promise.all(filePaths.map((filename, index) => writeFile(filename, `Sample upload ${index}`)));
    const wait = vi.spyOn(session, 'waitForAction');
    try { await core.upload_file({ ...target(), uid: uid('Sample upload'), filePaths, allowedRoots: [root] }); expect(wait).not.toHaveBeenCalled(); expect(await page.$eval('#sample-upload', element => [...(element as HTMLInputElement).files!].map(file => file.name))).toEqual(['sample-one.txt', 'sample-two.txt']); }
    finally { wait.mockRestore(); }
  });
  it('capability wait_for matches any requested text and captures latest AX', async () => {
    await page.evaluate(() => { setTimeout(() => { document.querySelector('#sample-late')!.textContent = 'Sample delayed result'; }, 60); });
    const result = await core.wait_for({ ...target(), text: ['Sample absent alternative', 'Sample delayed result'], timeout: 3000 });
    expect(result).toContain('Sample delayed result'); expect(result).toContain('uid=');
  });
  it('capability handle_dialog resolves the actual prompt with promptText', async () => {
    await observe(); expect(await core.click({ ...target(), uid: uid('Sample prompt'), includeSnapshot: true })).toContain('dialog');
    expect(session.getDialog(pageId)?.message()).toBe('Sample fictional prompt');
    expect(await core.handle_dialog({ ...target(), action: 'accept', promptText: 'Sample answer' })).toContain('Successfully accepted');
    expect((await state()).prompt).toBe('Sample answer'); expect(session.getDialog(pageId)).toBeUndefined();
  });
  it('capability take_screenshot returns actual PNG in the image channel and explicit JPEG file', async () => {
    const result = await skill.functions.take_screenshot.run({ pageId, format: 'png' }, toolContext());
    expect(result.images?.[0]?.mediaType).toBe('image/png');
    const bytes = Buffer.from(result.images![0]!.base64, 'base64'); expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.readUInt32BE(16)).toBe(1100); expect(bytes.readUInt32BE(20)).toBe(1000); await writeFile(join(root, 'sample-image-channel.png'), bytes);
    const saved = await core.take_screenshot({ ...target(), format: 'jpeg', quality: 65, fullPage: true, filePath: 'sample-full.out' });
    expect(saved.image).toBeUndefined(); expect(saved.filePath).toBe(join(root, 'sample-full.jpeg')); expect((await readFile(saved.filePath!)).subarray(0, 2)).toEqual(Buffer.from([255, 216]));
  });
  it('capability evaluate_script awaits async UID arguments, writes DOM and JSON files', async () => {
    await observe(); const arg = uid('Sample field 01');
    const result = await core.evaluate_script({ ...target(), function: "async element => { await Promise.resolve(); element.value = 'Sample script value'; return {value:element.value}; }", args: [arg], waitForStableDom: false });
    expect(result).toContain('Sample script value'); expect((await values())[0]).toBe('Sample script value');
    await core.evaluate_script({ ...target(), function: "() => ({result:'Sample file value'})", filePath: 'sample-script.out' });
    expect(JSON.parse(await readFile(join(root, 'sample-script.json'), 'utf8'))).toEqual({ result: 'Sample file value' });
  });
  it('capability list_console_messages filters groups and pages real console messages', async () => {
    await traffic(); const result = await core.list_console_messages({ ...target(), types: ['log'], pageSize: 1, pageIdx: 99 });
    expect(result).toContain('Invalid page number provided'); expect(result).toContain('Sample repeated message');
    expect(result).toContain('[2 times]'); expect(result.match(/Sample repeated message/g)).toHaveLength(1);
    evidence.consoleGrouping = result;
    expect(await core.list_console_messages({ ...target(), serviceWorkerId: 'sample-missing-worker' })).toContain('<no console messages found>');
  });
  it('capability get_console_message retrieves actual message arguments by stable ID', async () => {
    await traffic(); const collector = session.getConsoleCollector(pageId); const message = collector.getData().find(item => 'text' in item && item.text() === 'Sample warning')!;
    const id = collector.getIdForResource(message); expect(await core.get_console_message({ ...target(), msgid: id })).toContain('Sample warning');
    expect(await core.get_console_message({ ...target(), msgid: id })).toContain(`ID: ${id}`);
  });
  it('capability list_network_requests filters real fetch requests and pages them', async () => {
    await traffic(); const result = await core.list_network_requests({ ...target(), resourceTypes: ['fetch'], pageSize: 1, pageIdx: 99 });
    expect(result).toContain('Invalid page number provided'); expect(result).toContain('/sample-body'); expect(result).toContain('reqid=');
  });
  it('network detail truncates only the inline body and saves the complete real body file', async () => {
    await traffic(); const reqid = requestId('/sample-large-body');
    const result = await core.get_network_request({ ...target(), reqid });
    expect(result).toContain('... <truncated>');
    const saved = await core.get_network_request({ ...target(), reqid, responseFilePath: 'sample-large-body.out' });
    expect(saved).not.toContain('... <truncated>');
    expect(await readFile(join(root, 'sample-large-body.network-response'), 'utf8')).toBe('Sample large response '.repeat(650));
    evidence.truncatedBody = { reqid, inlineBytes: Buffer.byteLength(result), savedBytes: (await readFile(join(root, 'sample-large-body.network-response'))).length };
  });
  it('capability get_network_request preserves headers and real request and response body files', async () => {
    await traffic(); const reqid = requestId('/sample-body'); const result = await core.get_network_request({ ...target(), reqid, requestFilePath: 'sample-request.out', responseFilePath: 'sample-response.out' });
    expect(result).toContain('x-sample-header:Sample public header'); expect(result).toContain('x-sample-response:Sample public response');
    expect(await readFile(join(root, 'sample-request.network-request'), 'utf8')).toBe('Sample request body');
    expect(await readFile(join(root, 'sample-response.network-response'), 'utf8')).toBe('Sample response body: Sample request body');
    expect(await core.get_network_request(target())).toContain('Nothing is currently selected in the DevTools Network panel.');
  });

  it.each(['click', 'hover', 'fill', 'fill_form', 'press_key', 'drag', 'upload_file'] as const)('optional AX %s verifies default, false and true on separate real actions', async name => {
    await observe(); const files = [join(root, 'sample-optional.txt')]; await writeFile(files[0]!, 'Sample optional upload');
    const invoke = (includeSnapshot?: boolean) => {
      const params = { ...target(), ...(includeSnapshot === undefined ? {} : { includeSnapshot }) };
      switch (name) {
        case 'click': return core.click({ ...params, uid: uid('Sample stable') });
        case 'hover': return core.hover({ ...params, uid: uid('Sample hover') });
        case 'fill': return core.fill({ ...params, uid: uid('Sample field 01'), value: `Sample value ${String(includeSnapshot)}` });
        case 'fill_form': return core.fill_form({ ...params, elements: [{ uid: uid('Sample field 02'), value: `Sample batch ${String(includeSnapshot)}` }] });
        case 'press_key': return core.press_key({ ...params, key: 'Tab' });
        case 'drag': return core.drag({ ...params, from_uid: uid('Sample drag'), to_uid: uid('Sample drop') });
        case 'upload_file': return core.upload_file({ ...params, uid: uid('Sample upload'), filePaths: files, allowedRoots: [root] });
      }
    };
    const ax = vi.spyOn(page.accessibility, 'snapshot');
    try {
      const cached = session.getActiveSnapshot(pageId);
      for (const option of [undefined, false]) { expect(await invoke(option)).not.toContain('## Latest page snapshot'); expect(ax).not.toHaveBeenCalled(); expect(session.getActiveSnapshot(pageId)).toBe(cached); }
      expect(await invoke(true)).toContain('uid='); expect(ax).toHaveBeenCalledOnce(); expect(session.getActiveSnapshot(pageId)).not.toBe(cached);
    } finally { ax.mockRestore(); }
  });

  it('chain static form locates pages observes fills ten fields clicks and reads final result', async () => {
    const pages = await core.list_pages({ browserId }); expect(pages).toContain(`${pageId}:`); await observe();
    const expected = Array.from({ length: 10 }, (_, index) => `Sample chain value ${index + 1}`);
    const elements = expected.map((value, index) => ({ uid: uid(`Sample field ${String(index + 1).padStart(2, '0')}`), value }));
    await core.fill_form({ ...target(), elements });
    const result = await core.click({ ...target(), uid: uid('Sample submit'), includeSnapshot: true });
    expect(result).toContain('Sample form complete'); expect(await values()).toEqual(expected); expect(await state()).toMatchObject({ submits: 1, submitted: expected });
    evidence.formChain = { expected, actual: await state(), result };
  });
  it('chain unknown menu observes new choices before choosing and reuses continuously observed UID', async () => {
    await observe(); const stable = uid('Sample stable');
    const menu = await core.click({ ...target(), uid: uid('Sample menu'), includeSnapshot: true }); expect(menu).toContain('Sample generated option');
    expect(uid('Sample stable')).toBe(stable);
    await core.click({ ...target(), uid: uid('Sample generated option') }); await core.click({ ...target(), uid: stable });
    expect(await observe()).toContain('Sample option chosen'); expect(await state()).toMatchObject({ option: 'chosen', stable: 1 });
  });
  it('chain dialog interruption stops later fields then handles observes and completes remaining input', async () => {
    await observe(); const ax = vi.spyOn(page.accessibility, 'snapshot');
    let result: string;
    try {
      result = await core.fill_form({ ...target(), elements: ['first', 'second', 'third'].map(part => ({ uid: uid(`Sample dialog ${part}`), value: `Sample ${part}` })), includeSnapshot: true });
      expect(result).toContain('The remaining elements were not filled out.'); expect(ax).not.toHaveBeenCalled(); expect(session.getDialog(pageId)?.message()).toBe('Sample form interruption');
    } finally { ax.mockRestore(); }
    await core.handle_dialog({ ...target(), action: 'accept' }); await observe();
    const before = await page.$$eval('input[id^="sample-dialog-"]', elements => elements.map(element => (element as HTMLInputElement).value));
    expect(before[0]).toBe('Sample first'); expect(before[2]).toBe('');
    await core.fill({ ...target(), uid: uid('Sample dialog third'), value: 'Sample recovered' });
    expect(await page.$eval('#sample-dialog-third', element => (element as HTMLInputElement).value)).toBe('Sample recovered');
    evidence.dialogChain = { result, before, after: await page.$$eval('input[id^="sample-dialog-"]', elements => elements.map(element => (element as HTMLInputElement).value)) };
  });
  it('chain keyboard selection submitKey and multiple uploads confirms independent final effects', async () => {
    await observe(); await core.click({ ...target(), uid: uid('Sample typing') });
    await core.type_text({ ...target(), text: 'Sample old entry' }); await core.press_key({ ...target(), key: 'Control+A' });
    await core.type_text({ ...target(), text: 'Sample submitted entry', submitKey: 'Enter' });
    const filePaths = [join(root, 'sample-chain-one.txt'), join(root, 'sample-chain-two.txt')]; await Promise.all(filePaths.map(filename => writeFile(filename, 'Sample chain upload')));
    await core.upload_file({ ...target(), uid: uid('Sample upload'), filePaths, allowedRoots: [root], includeSnapshot: true });
    expect((await state()).typed).toEqual(['Sample submitted entry']); expect(await page.$eval('#sample-upload', element => (element as HTMLInputElement).files!.length)).toBe(2);
  });
  it('chain iframe async same-frame arguments writes DOM and produces real screenshot and script files', async () => {
    await observe(); const first = uid('Sample iframe input');
    const result = await core.evaluate_script({ ...target(), function: "async input => { await Promise.resolve(); input.value='Sample frame write'; return {value:input.value,frame:location.pathname}; }", args: [first] });
    expect(result).toContain('Sample frame write'); expect(result).toContain('/sample-frame');
    const frame = page.frames().find(item => item.name() === 'sample-same')!;
    expect(await frame.$eval('input', element => element.value)).toBe('Sample frame write');
    await core.evaluate_script({ ...target(), function: 'async input => ({value:input.value})', args: [first], waitForStableDom: false, filePath: 'sample-frame-data.out' });
    await core.take_screenshot({ ...target(), uid: first, filePath: 'sample-frame-picture.out' });
    expect(JSON.parse(await readFile(join(root, 'sample-frame-data.json'), 'utf8'))).toEqual({ value: 'Sample frame write' });
    expect((await readFile(join(root, 'sample-frame-picture.png'))).subarray(1, 4).toString()).toBe('PNG');
    await expect(core.evaluate_script({ ...target(), function: '(a,b) => [a.value,b.value]', args: [first, uid('Sample field 01')] })).rejects.toThrow("Elements from different frames can't be evaluated together.");
  });
  it('chain console network grouping details files and same versus cross-document preservation', async () => {
    await traffic(); const logs = await core.list_console_messages({ ...target(), types: ['log'], pageSize: 1 }); expect(logs).toContain('Sample repeated message');
    const networks = await core.list_network_requests({ ...target(), resourceTypes: ['fetch'], pageSize: 1 }); expect(networks).toContain('/sample-body');
    const reqid = requestId('/sample-body'); const collector = session.getConsoleCollector(pageId); const message = collector.getData().find(item => 'text' in item && item.text() === 'Sample repeated message')!; const msgid = collector.getIdForResource(message);
    expect(await core.get_console_message({ ...target(), msgid })).toContain('Sample repeated message');
    await core.get_network_request({ ...target(), reqid, responseFilePath: 'sample-chain-body.out' }); expect(await readFile(join(root, 'sample-chain-body.network-response'), 'utf8')).toContain('Sample response body');
    await core.evaluate_script({ ...target(), function: "() => { history.pushState({},'', '#sample-state'); return location.hash; }", waitForStableDom: false });
    expect(await core.list_console_messages(target())).toContain('Sample repeated message');
    await core.navigate_page({ ...target(), url: `${baseUrl}/sample-next` });
    expect(await core.list_console_messages(target())).not.toContain('Sample repeated message');
    expect(await core.list_console_messages({ ...target(), includePreservedMessages: true })).toContain('Sample repeated message');
    expect(await core.list_network_requests({ ...target(), includePreservedRequests: true })).toContain('/sample-body');
    expect(await core.get_console_message({ ...target(), msgid })).toContain('Sample repeated message');
    expect(await core.get_network_request({ ...target(), reqid })).toContain('Sample request body');
  }, 15_000);

  it('AX boundaries restore srcdoc and actual OOPIF handles then reject old UIDs after navigation', async () => {
    await observe(); const oldMain = uid('Sample field 01'); const srcdoc = uid('Sample srcdoc input'); const cross = uid('Sample cross input');
    await core.fill({ ...target(), uid: srcdoc, value: 'Sample srcdoc value' }); await core.fill({ ...target(), uid: cross, value: 'Sample cross value' });
    const sameFrame = page.frames().find(item => item.name() === 'sample-srcdoc')!; const crossFrame = page.frames().find(item => item.name() === 'sample-cross')!;
    expect(await sameFrame.$eval('input', element => element.value)).toBe('Sample srcdoc value'); expect(await crossFrame.$eval('input', element => element.value)).toBe('Sample cross value');
    const transport = await browser.target().createCDPSession(); const targets = await transport.send('Target.getTargets'); await transport.detach();
    expect(targets.targetInfos.some(item => item.type === 'iframe' && item.url.includes('localhost'))).toBe(true);
    evidence.axBoundaries = { srcdocNode: session.getAXNodeByUid(srcdoc, pageId), crossNode: session.getAXNodeByUid(cross, pageId), targets: targets.targetInfos.filter(item => item.type === 'iframe') };
    const frame = page.frames().find(item => item.name() === 'sample-same')!; const oldFrame = uid('Sample iframe input'); await frame.goto(`${baseUrl}/sample-frame?new-document`); await observe();
    expect(uid('Sample iframe input')).not.toBe(oldFrame); await expect(core.fill({ ...target(), uid: oldFrame, value: 'Sample stale value' })).rejects.toThrow('not found');
    await core.navigate_page({ ...target(), url: `${baseUrl}/sample-next` }); await observe();
    expect(uid('Sample field 01')).not.toBe(oldMain); await expect(core.fill({ ...target(), uid: oldMain, value: 'Sample stale value' })).rejects.toThrow('not found');
  }, 15_000);
  it('about blank AX records real optional identity metadata and resolves a srcdoc input', async () => {
    await core.navigate_page({ ...target(), url: 'about:blank' });
    await page.setContent('<!doctype html><iframe title="Sample blank frame" srcdoc="<input aria-label=\'Sample blank input\'>"></iframe>');
    await observe(); const input = uid('Sample blank input');
    await core.fill({ ...target(), uid: input, value: 'Sample blank value' });
    const frame = page.frames().find(item => item !== page.mainFrame())!;
    expect(await frame.$eval('input', element => element.value)).toBe('Sample blank value');
    const nodes = [...session.getActiveSnapshot(pageId)!.idToNode.values()];
    evidence.blankAX = { pageId, url: page.url(), input, nodes: nodes.map(({ id, role, loaderId, backendNodeId }) => ({ id, role, loaderId, backendNodeId })), absentBackend: nodes.filter(node => node.backendNodeId === undefined).length, emptyLoader: nodes.filter(node => !node.loaderId).length };
  });
  it('UID pruning rejects replaced and hidden nodes and allocates a new identity when shown again', async () => {
    await observe(); const original = uid('Sample stable'); await page.$eval('#sample-stable', element => { element.replaceWith(element.cloneNode(true)); }); await observe();
    const replacement = uid('Sample stable'); expect(replacement).not.toBe(original); await expect(core.click({ ...target(), uid: original })).rejects.toThrow('not found');
    await page.$eval('#sample-stable', element => { (element as HTMLElement).hidden = true; }); await observe();
    await page.$eval('#sample-stable', element => { (element as HTMLElement).hidden = false; }); await observe(); expect(uid('Sample stable')).not.toBe(replacement);
  });
  it('real mapped stacks and native CORS issues use the collector-owned frontend graph', async () => {
    await session.getConsoleCollector(pageId).devTools.ready;
    await page.evaluate(async crossUrl => {
      (window as unknown as { sampleMappedFailure(): void }).sampleMappedFailure();
      await fetch(crossUrl).catch(() => undefined);
    }, `${baseUrl.replace('127.0.0.1', 'localhost')}/sample-cors`);
    const collector = session.getConsoleCollector(pageId);
    await vi.waitFor(() => expect(collector.getData().some(item => 'text' in item && item.text().includes('Sample mapped failure'))).toBe(true));
    const message = collector.getData().find(item => 'text' in item && item.text().includes('Sample mapped failure'))!;
    const detail = await core.get_console_message({ ...target(), msgid: collector.getIdForResource(message) });
    expect(detail).toContain('sample-original.js');
    const issues = await vi.waitFor(async () => { const result = await core.list_console_messages({ ...target(), types: ['issue'] }); expect(result).toContain('msgid='); return result; }, { timeout: 6000 });
    const msgid = Number(issues.match(/msgid=(\d+)/)?.[1]); const issue = await core.get_console_message({ ...target(), msgid });
    expect(issue).toContain('CORS'); evidence.frontend = { detail, issues, issue };
  }, 15_000);
  it('DevTools actual Elements and Network selections reach snapshot markers and omitted request detail', async () => {
    expect(await getDevToolsData(page)).toEqual({});
    expect(await core.get_network_request(target())).toContain('Nothing is currently selected');
    const panel = await page.openDevTools();
    try {
      await panel.waitForFunction(() => document.readyState === 'complete');
      await vi.waitFor(async () => expect(await panel.evaluate(async () => {
        const load = new Function('specifier', 'return import(specifier)');
        const SDK = await load('/bundled/core/sdk/sdk.js');
        return SDK.TargetManager.TargetManager.instance().models(SDK.DOMModel.DOMModel).length;
      })).toBeGreaterThan(0));
      const node = await panel.evaluate(async () => {
        const load = new Function('specifier', 'return import(specifier)');
        const [UI, SDK, Elements] = await Promise.all([load('/bundled/ui/legacy/legacy.js'), load('/bundled/core/sdk/sdk.js'), load('/bundled/panels/elements/elements.js')]);
        for (const model of SDK.TargetManager.TargetManager.instance().models(SDK.DOMModel.DOMModel)) {
          const doc = await model.requestDocument(); if (!doc) continue;
          const nodeId = await model.querySelector(doc.id, '#sample-field-01'); const node = model.nodeForId(nodeId); if (!node) continue;
          await Elements.ElementsPanel.ElementsPanel.instance().revealAndSelectNode(node);
          return { backend: node.backendNodeId(), selected: UI.Context.Context.instance().flavor(SDK.DOMModel.DOMNode)?.backendNodeId(), uiApi: typeof (window as Window & { DevToolsUIAPI?: unknown }).DevToolsUIAPI };
        }
        throw new Error('Sample panel node not found');
      });
      expect(node.selected).toBe(node.backend); expect(await getDevToolsData(page)).toMatchObject({ cdpBackendNodeId: node.backend });
      expect(await observe()).toContain('[selected in the DevTools Elements panel]');
      await panel.screenshot({ path: join(root, 'sample-devtools-elements.png') });
      await panel.evaluate(async () => { const load = new Function('specifier', 'return import(specifier)'); const UI = await load('/bundled/ui/legacy/legacy.js'); await UI.ViewManager.ViewManager.instance().showView('network'); });
      await page.evaluate(async () => { await fetch('/sample-body?sample-panel', { method: 'POST', body: 'Sample selected request' }).then(response => response.text()); });
      const selected = await vi.waitFor(async () => {
        const result = await panel.evaluate(async () => {
          const load = new Function('specifier', 'return import(specifier)');
          const [UI, SDK, Logs, Network] = await Promise.all([load('/bundled/ui/legacy/legacy.js'), load('/bundled/core/sdk/sdk.js'), load('/bundled/models/logs/logs.js'), load('/bundled/panels/network/network.js')]);
          const request = Logs.NetworkLog.NetworkLog.instance().requests().find((request: { url(): string }) => request.url().endsWith('/sample-body?sample-panel'));
          if (!request) return undefined;
          await Network.NetworkPanel.NetworkPanel.instance().selectAndActivateRequest(request);
          return { requestId: request.requestId(), selectedId: UI.Context.Context.instance().flavor(SDK.NetworkRequest.NetworkRequest)?.requestId() };
        });
        expect(result?.selectedId).toBeTruthy(); return result!;
      });
      expect(selected.selectedId).toBe(selected.requestId);
      expect(await getDevToolsData(page)).toMatchObject({ cdpRequestId: selected.requestId });
      expect(await core.list_network_requests(target())).toContain('[selected in the DevTools Network panel]');
      expect(await core.get_network_request(target())).toContain('Sample selected request');
      await panel.screenshot({ path: join(root, 'sample-devtools-network.png') });
      evidence.devtoolsSelection = { status: 'available', node, selected, metadata: await getDevToolsData(page), uiApiBoundary: 'Stock Chrome has no DevToolsUIAPI global; pinned source uses real frontend modules and both selections work.' };
    } finally { await panel.close(); }
    expect(await core.get_network_request(target())).toContain('Nothing is currently selected');
  }, 15_000);
  it('screenshot large real noisy PNG uses the temporary file branch and preserves actual dimensions', async () => {
    await page.setViewport({ width: 1500, height: 1000 });
    await page.evaluate(() => {
      document.body.innerHTML = '<canvas width="1500" height="1000" style="position:absolute;left:0;top:0"></canvas>';
      const canvas = document.querySelector('canvas')!; const context = canvas.getContext('2d')!; const image = context.createImageData(1500, 1000); let number = 123456789;
      for (let index = 0; index < image.data.length; index += 4) { number ^= number << 13; number ^= number >>> 17; number ^= number << 5; image.data[index] = number & 255; image.data[index + 1] = (number >>> 8) & 255; image.data[index + 2] = (number >>> 16) & 255; image.data[index + 3] = 255; } context.putImageData(image, 0, 0);
    });
    const result = await core.take_screenshot(target()); expect(result.image).toBeUndefined(); expect(result.filePath).toBeTruthy();
    const bytes = await readFile(result.filePath!); expect(bytes.length).toBeGreaterThanOrEqual(2_000_000); expect(bytes.readUInt32BE(16)).toBe(1500);
    evidence.largeScreenshot = { filePath: result.filePath, bytes: bytes.length, text: result.text };
  });
  it('script dialogAction auto-handles new prompts and serialization errors retain real page effects', async () => {
    const result = await core.evaluate_script({ ...target(), function: "() => ({answer:prompt('Sample script prompt')})", dialogAction: 'Sample script answer', waitForStableDom: false });
    expect(result).toContain('Sample script answer');
    expect(session.getDialog(pageId)?.handled).toBe(true);
    expect(() => session.throwIfDialogOpen(pageId)).not.toThrow();
    evidence.scriptHandledDialog = { retainedHandledReference: true, source: 'script.ts page branch 153-162 retains handled dialog; existing-dialog precheck ignores handled references' };
    await expect(core.evaluate_script({ ...target(), function: "() => { document.querySelector('#sample-type').value='Sample effect before error'; const value={}; value.self=value; return value; }", waitForStableDom: false })).rejects.toThrow();
    expect(await page.$eval('#sample-type', element => (element as HTMLInputElement).value)).toBe('Sample effect before error');
  });
  it('ordinary batch element failure stops later real fields without rolling back completed input', async () => {
    await observe(); await expect(core.fill_form({ ...target(), elements: [{ uid: uid('Sample field 01'), value: 'Sample completed' }, { uid: 'sample-missing-uid', value: 'Sample invalid' }, { uid: uid('Sample field 03'), value: 'Sample blocked' }] })).rejects.toThrow('sample-missing-uid');
    expect((await values()).slice(0, 3)).toEqual(['Sample completed', '', '']);
  });
  it('host routing difference evaluate_script pageId zero rejects unknown ID without acting on valid pages', async () => {
    await core.new_page({ browserId, url: `${baseUrl}/sample-next`, background: true });
    const other = session.getSelectedPage(); const otherId = session.getSelectedPageId();
    await core.select_page(target());
    await expect(core.evaluate_script({ ...target(), pageId: 0,
      function: "() => { document.querySelector('#sample-type').value='Sample unintended write'; return location.href; }" })).rejects.toThrow('No page found');
    expect(session.getSelectedPageId()).toBe(pageId);
    expect(await page.$eval('#sample-type', element => (element as HTMLInputElement).value)).toBe('');
    expect(await other.$eval('#sample-type', element => (element as HTMLInputElement).value)).toBe('');
    evidence.zeroPageRouting = { requestedId: 0, selectedId: pageId, otherId, result: 'unknown ID rejected before script dispatch', sourceDifference: 'script.ts:134-137 truthy pageId falls back to selected; host explicit routing uses Manager lookup' };
  });
  it('navigation Unable result reports a real connection failure and retains a live page owner', async () => {
    const result = await core.navigate_page({ ...target(), url: 'http://127.0.0.1:1/sample', timeout: 1000 });
    expect(result).toContain('Unable to navigate'); expect(result).toContain('## Pages'); expect(page.isClosed()).toBe(false);
  });
});
