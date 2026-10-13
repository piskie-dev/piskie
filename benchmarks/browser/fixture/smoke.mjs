import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios } from './scenarios.mjs';

const attachmentPath = fileURLToPath(new URL('./data/parcel-note.txt', import.meta.url));
const fill = (page, selector, value) => page.locator(selector).fill(String(value));
const click = (page, selector) => page.locator(selector).click();
const waitText = (page, selector, text) => page.waitForFunction((selector, text) => document.querySelector(selector)?.textContent.includes(text), {}, selector, text);
function waitEvent(emitter, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const listener = (value) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timed out waiting for browser event: ${event}.`)); }, timeout);
    emitter.once(event, listener);
  });
}
async function navigateSection(page, name) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    click(page, `nav a[href*="view=${name}"]`),
  ]);
  await page.waitForSelector('#view-content');
}

async function intake(page) {
  await page.waitForSelector('#intake-form');
  await fill(page, '[name="customer"]', 'Aster Demo Co');
  await fill(page, '[name="contact"]', 'Riley Demo');
  await fill(page, '[name="email"]', 'riley@example.invalid');
  await fill(page, '[name="units"]', '12');
  await fill(page, '[name="service"]', 'Express');
  await fill(page, '[name="deliveryDate"]', '2030-06-18');
  await click(page, '[name="priority"][value="High"]');
  await fill(page, '[name="notes"]', 'Demo launch allocation');
  await click(page, '[name="insured"]');
  await click(page, '[name="terms"]');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), click(page, '#intake-form button[type="submit"]')]);
  await page.waitForSelector('[aria-label="Service request receipt"]');
}
async function inventory(page) {
  await page.waitForSelector('#inventory-filter');
  await fill(page, '#inventory-filter [name="region"]', 'East');
  await fill(page, '#inventory-filter [name="availability"]', 'Ready');
  await click(page, '#inventory-filter button[type="submit"]');
  await page.waitForSelector('#inventory-results[aria-busy="false"]');
  await click(page, '#refresh-stock');
  await waitText(page, '#feedback', 'Stock refreshed');
  while (!(await page.$('#reserve-DEMO-042'))) {
    const next = await page.$('#next-page:not([disabled])');
    if (!next) throw new Error('DEMO-042 was not found in the East / Ready result pages.');
    const before = await page.$eval('#page-status', (element) => element.textContent);
    await next.click();
    await page.waitForFunction((before) => {
      const status = document.querySelector('#page-status');
      return status && status.textContent !== before && document.querySelector('#inventory-results')?.getAttribute('aria-busy') === 'false';
    }, {}, before);
  }
  await fill(page, '#quantity-DEMO-042', '7');
  await click(page, '#reserve-DEMO-042');
  await waitText(page, '#feedback', '7 units of DEMO-042 allocated');
}
async function approvals(page) {
  await page.waitForSelector('[data-approval="APR-204"]');
  await page.hover('[aria-label="Review note for APR-204"]');
  await page.waitForSelector('#note-APR-204', { visible: true });
  const note = await page.$eval('#note-APR-204', (element) => element.textContent);
  const reviewCode = /Review code:\s*(\S+)/.exec(note)?.[1];
  if (!reviewCode) throw new Error('The hover review note did not contain a finance reference.');
  let confirmations = 0;
  const handler = async (dialog) => {
    if (dialog.type() === 'confirm') { confirmations++; if (confirmations === 1) await dialog.dismiss(); else await dialog.accept(); }
    else if (dialog.type() === 'prompt') await dialog.accept(reviewCode);
    else await dialog.accept();
  };
  const pending = [];
  const listener = (dialog) => { pending.push(handler(dialog)); };
  page.on('dialog', listener);
  try {
    await page.hover('[data-approval="APR-204"]');
    await click(page, '[data-menu="APR-204"]');
    await click(page, '[data-approve="APR-204"]');
    await waitText(page, '#feedback', 'Approval cancelled');
    await click(page, '[data-approve="APR-204"]');
    await waitText(page, '#feedback', 'APR-204 approved');
    await Promise.all(pending);
  } finally { page.off('dialog', listener); }
}
async function dragParcel(page, lane) {
  const source = await page.waitForSelector('#parcel-PAR-104 h3');
  const target = await page.waitForSelector(`[data-lane="${lane}"]`);
  // Puppeteer performs a real pointer drag; no synthetic drop or state mutation is used.
  await target.drop(source);
  await page.waitForSelector(`[data-lane="${lane}"] #parcel-PAR-104`);
}
async function board(page) {
  await dragParcel(page, 'Packed');
  const input = await page.waitForSelector('[data-upload="PAR-104"]');
  await input.uploadFile(attachmentPath);
  await waitText(page, '#parcel-PAR-104', 'Attached: parcel-note.txt');
  await dragParcel(page, 'Dispatched');
  await waitText(page, '#feedback', 'Dispatch receipt recorded');
}
async function frames(page) {
  const outer = await page.waitForFrame((frame) => frame.url().includes('level=outer'));
  let inner = await page.waitForFrame((frame) => frame.url().includes('level=inner'));
  const selector = (id) => `routing-editor >>> ${id}`;
  await inner.waitForSelector(selector('#routing-form'));
  await fill(inner, selector('#depot'), 'harbor');
  await fill(inner, selector('#reorder'), '24');
  await fill(inner, selector('#lane-label'), 'Demo coastal lane');
  await click(inner, selector('#cold-chain'));
  await click(inner, selector('button[type="submit"]'));
  await inner.waitForFunction(() => document.querySelector('routing-editor')?.shadowRoot.querySelector('#routing-feedback')?.textContent.includes('Routing settings saved'));
  await Promise.all([inner.waitForNavigation({ waitUntil: 'domcontentloaded' }), click(outer, '#reload-routing')]);
  inner = await page.waitForFrame((frame) => frame.url().includes('level=inner') && frame.url().includes('revision='));
  await inner.waitForSelector(selector('#routing-form'));
  const visibleValues = await inner.$eval('routing-editor', (element) => {
    const shadow = element.shadowRoot;
    return { depot: shadow.querySelector('#depot').value, reorder: shadow.querySelector('#reorder').value, label: shadow.querySelector('#lane-label').value, coldChain: shadow.querySelector('#cold-chain').checked };
  });
  if (JSON.stringify(visibleValues) !== JSON.stringify({ depot: 'harbor', reorder: '24', label: 'Demo coastal lane', coldChain: true })) throw new Error('The remounted routing editor did not show the saved values.');
}
async function tabs(page) {
  await page.waitForSelector('#open-PO-731');
  const seal = await page.$eval('[data-order="PO-731"] .detail-grid > div:nth-child(2) dd', (element) => element.textContent);
  const [popup] = await Promise.all([waitEvent(page, 'popup'), click(page, '#open-PO-731')]);
  popup.setDefaultTimeout(15000);
  await popup.waitForSelector('#receiving-form');
  await fill(popup, '[name="receiver"]', 'Morgan Demo');
  await fill(popup, '[name="seal"]', seal);
  await fill(popup, '[name="condition"]', 'Good');
  await click(popup, '[name="counted"]');
  await click(popup, '#receiving-form button[type="submit"]');
  await popup.waitForSelector('[aria-label="Receiving receipt"]');
  await Promise.all([waitEvent(popup, 'close'), click(popup, '#close-confirmation').catch((error) => { if (!popup.isClosed()) throw error; })]);
  await page.bringToFront();
  await click(page, '#refresh-confirmations');
  await page.waitForSelector('[data-reconcile="PO-731"]:not([disabled])');
  await click(page, '[data-reconcile="PO-731"]');
  await waitText(page, '#feedback', 'PO-731 reconciled');
}
async function diagnostics(page) {
  await page.waitForSelector('#health-check');
  const failure = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/connector') && response.status() === 503);
  await click(page, '#health-check');
  const evidence = await (await failure).json();
  await waitText(page, '#health-feedback', 'Health check failed');
  await click(page, '#start-scan');
  await page.waitForSelector('#cancel-scan:not([disabled])');
  await click(page, '#cancel-scan');
  await waitText(page, '#scan-feedback', 'cancelled');
  await fill(page, '[name="connector"]', 'v2');
  await click(page, '#connector-form button[type="submit"]');
  await waitText(page, '#feedback', 'Connector configuration saved');
  await click(page, '#health-check');
  await waitText(page, '#health-feedback', 'Connector ready');
  await fill(page, '[name="errorCode"]', evidence.code);
  await fill(page, '[name="traceId"]', evidence.traceId);
  await fill(page, '[name="note"]', 'Demo connector migrated');
  await click(page, '#resolution-form button[type="submit"]');
  await waitText(page, '#feedback', 'Incident INC-001 resolved');
}
async function journey(page) {
  await navigateSection(page, 'intake'); await intake(page);
  await navigateSection(page, 'inventory'); await inventory(page);
  await navigateSection(page, 'board'); await board(page);
  await navigateSection(page, 'tabs'); await tabs(page);
  await navigateSection(page, 'journey');
  await click(page, '#finalize-order');
  await page.waitForSelector('[aria-label="Final order record"]');
}
const exercises = { intake, inventory, approvals, board, frames, tabs, diagnostics, journey };

export function checkConsoleEvidence(entries, allowMissingConsole = false) {
  const observed = entries.some((entry) => entry.type === 'error' && entry.text.includes('DEMO_ROUTE_RETIRED'));
  if (observed) return [];
  if (entries.some((entry) => entry.type === 'error' && entry.text.startsWith('Connector '))) throw new Error('The connector console evidence does not match the failed request.');
  if (!allowMissingConsole) throw new Error('The failed connector did not emit its console evidence.');
  return [{ capability: 'console', status: 'unavailable', reason: 'Fingerprint browser does not expose console events; network evidence was verified.' }];
}

/** Real UI smoke only. It does not represent model speed, tokens, or model step counts. */
export async function runFixtureSmoke({ baseUrl, browser, artifactDir, scenarioIds = scenarios.map((scenario) => scenario.id), seed = 1, allowMissingConsole = false }) {
  if (!browser || !baseUrl) throw new Error('baseUrl and a connected Puppeteer browser are required.');
  if (!artifactDir || !isAbsolute(artifactDir)) throw new Error('artifactDir must be an absolute temporary output directory.');
  if (!Array.isArray(scenarioIds) || scenarioIds.some((id) => !Object.hasOwn(exercises, id))) throw new Error('scenarioIds must contain known fixture scenario IDs.');
  await mkdir(artifactDir, { recursive: true });
  const results = [];
  for (const scenarioId of scenarioIds) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let run = null;
    let result = null;
    let error;
    let context;
    let page;
    const consoleEntries = [];
    const requests = [];
    const artifacts = {};
    let capabilityNotes = [];
    try {
      const response = await fetch(`${baseUrl}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenarioId, seed }) });
      run = await response.json();
      if (!response.ok) throw new Error(run.error);
      context = await browser.createBrowserContext();
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(20000);
      await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
      page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text() }));
      page.on('pageerror', (error) => consoleEntries.push({ type: 'pageerror', text: error.message }));
      page.on('response', (response) => requests.push({ url: response.url(), status: response.status(), method: response.request().method() }));
      await page.goto(run.url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#view-content');
      await exercises[scenarioId](page);
      if (consoleEntries.some((entry) => entry.type === 'pageerror')) throw new Error('The page emitted an uncaught JavaScript error.');
      if (scenarioId === 'diagnostics') capabilityNotes = checkConsoleEvidence(consoleEntries, allowMissingConsole);
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally {
      if (run?.runId) {
        try {
          const response = await fetch(`${baseUrl}/api/runs/${run.runId}/result`);
          const evaluation = await response.json();
          if (response.ok) result = evaluation;
          else error = [error, `Oracle: ${evaluation.error ?? response.status}`].filter(Boolean).join('; ');
        } catch (caught) { error = [error, `Oracle: ${caught.message}`].filter(Boolean).join('; '); }
      }
      const endedAt = new Date().toISOString();
      const wallTimeMs = performance.now() - started;
      const basename = `${scenarioId}-${run?.runId ?? 'uncreated'}`;
      try {
        if (page && !page.isClosed()) {
          artifacts.screenshot = join(artifactDir, `${basename}.png`);
          await page.screenshot({ path: artifacts.screenshot, fullPage: true });
        }
        artifacts.observations = join(artifactDir, `${basename}-observations.json`);
        await writeFile(artifacts.observations, JSON.stringify({ console: consoleEntries, network: requests }, null, 2) + '\n');
      } catch (caught) { error = [error, `Artifacts: ${caught.message}`].filter(Boolean).join('; '); }
      if (context) await context.close().catch((caught) => { error = [error, `Browser cleanup: ${caught.message}`].filter(Boolean).join('; '); });
      results.push({ run, result, startedAt, endedAt, wallTimeMs, ...(error ? { error } : {}), artifacts, capabilityNotes });
    }
  }
  return results;
}
