import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserAutomationSession } from '../../../electron/piskiepilot/browser/core/session/browser-automation-session.js';
import type { TextSnapshotNode } from '../../../electron/piskiepilot/browser/core/session/text-snapshot.js';
import * as tools from '../../../electron/piskiepilot/browser/skills/browser/index.js';

export const viewport = { width: 1440, height: 1000 };

type ToolName = Extract<keyof typeof tools, Lowercase<keyof typeof tools>>;
type ToolInput<K extends ToolName> = Parameters<(typeof tools)[K]>[0];
type ToolOutput<K extends ToolName> = Awaited<ReturnType<(typeof tools)[K]>>;
type Name = string | RegExp;
type ConsoleEvidencePolicy = 'optional' | 'required';

interface CapabilityNote {
  capability: 'console';
  status: 'unavailable';
  reason: string;
}

export interface FixtureRun {
  runId: string;
  scenarioId: string;
  seed: number;
  url: string;
  task: string;
}

export interface ToolTiming {
  index: number;
  name: ToolName;
  phase: 'task' | 'cleanup';
  pageId?: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  failed: boolean;
  error?: string;
}

interface ToolEvent extends ToolTiming {
  input: unknown;
  output?: unknown;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || /\b(?:timed out|timeout|deadline exceeded)\b/i.test(error.message)
    || isTimeoutError(error.cause);
}

/** Mutations go through current source tools; snapshots are the sole UID owner. */
export class SourceTools {
  readonly events: ToolEvent[] = [];
  readonly ownedPages = new Set<number>();
  readonly capabilityNotes: CapabilityNote[] = [];
  phase: ToolTiming['phase'] = 'task';
  pageId: number;
  private signal?: AbortSignal;

  constructor(
    readonly session: BrowserAutomationSession,
    readonly browserId: string,
    readonly artifactDir: string,
    signal: AbortSignal,
    readonly consoleEvidencePolicy: ConsoleEvidencePolicy = 'required',
  ) {
    this.pageId = session.getSelectedPageId();
    this.signal = signal;
  }

  target(pageId = this.pageId) {
    return {
      browserId: this.browserId, pageId, signal: this.signal,
      files: { cwd: this.artifactDir, tempDir: this.artifactDir, allowedRoots: [this.artifactDir] },
    };
  }

  async call<K extends ToolName>(name: K, input: ToolInput<K>): Promise<ToolOutput<K>> {
    const start = performance.now();
    const recordedInput = { ...input };
    delete recordedInput.signal;
    const event: ToolEvent = {
      index: this.events.length + 1, name, phase: this.phase,
      ...('pageId' in input ? { pageId: input.pageId as number } : {}),
      startedAt: new Date().toISOString(), endedAt: '', durationMs: 0,
      failed: false, input: recordedInput,
    };
    this.events.push(event);
    try {
      const invoke = tools[name] as (parameters: ToolInput<K>) => Promise<ToolOutput<K>>;
      const output = await invoke({ ...input, signal: input.signal ?? this.signal });
      event.output = output;
      return output;
    } catch (error) {
      event.failed = true;
      event.error = errorText(error);
      throw error;
    } finally {
      event.endedAt = new Date().toISOString();
      event.durationMs = performance.now() - start;
    }
  }

  async open(run: FixtureRun) {
    await this.call('new_page', {
      browserId: this.browserId, signal: this.signal, url: 'about:blank',
      isolatedContext: run.runId,
    });
    this.pageId = this.session.getSelectedPageId();
    this.ownedPages.add(this.pageId);
    await this.page().setViewport(viewport);
    await this.call('navigate_page', { ...this.target(), url: run.url, timeout: 15_000 });
  }

  page() { return this.session.getPageById(this.pageId); }

  async observe(verbose = false) {
    return this.call('take_snapshot', { ...this.target(), verbose });
  }

  nodes(): TextSnapshotNode[] {
    const snapshot = this.session.getActiveSnapshot(this.pageId);
    assert(snapshot, `Page ${this.pageId} needs a current UI snapshot`);
    return [...snapshot.idToNode.values()];
  }

  find(name: Name, roles?: readonly string[]): TextSnapshotNode | undefined {
    return this.nodes().find((node) => (!roles || roles.includes(node.role))
      && (typeof name === 'string' ? node.name === name : name.test(node.name ?? '')));
  }

  uid(name: Name, roles?: readonly string[]) {
    const candidates = this.nodes().filter((node) => (!roles || roles.includes(node.role))
      && (typeof name === 'string' ? node.name === name : name.test(node.name ?? '')));
    assert.equal(candidates.length, 1, `Expected one UI control ${String(name)} (${roles?.join(', ') ?? 'any role'}), found ${candidates.length}`);
    return candidates[0]!.id;
  }

  async click(name: Name, roles: readonly string[] = ['button', 'link', 'menuitem']) {
    return this.call('click', { ...this.target(), uid: this.uid(name, roles) });
  }

  async fill(fields: Array<[Name, string]>) {
    const editable = ['textbox', 'spinbutton', 'combobox', 'checkbox', 'radio', 'Date', 'InputTime'];
    return this.call('fill_form', {
      ...this.target(), elements: fields.map(([name, value]) => ({ uid: this.uid(name, editable), value })),
    });
  }

  async wait(text: string | string[]) {
    return this.call('wait_for', { ...this.target(), text: typeof text === 'string' ? [text] : text, timeout: 10_000 });
  }

  async selectPage(pageId: number) {
    await this.call('select_page', { ...this.target(pageId), bringToFront: false });
    this.pageId = pageId;
    await this.page().setViewport(viewport);
  }

  async upload(name: Name, run: FixtureRun) {
    const attachment = /attachment is at (.+?) on the browser tool host/.exec(run.task)?.[1];
    assert(attachment, 'The public scenario task must supply its attachment path');
    await this.call('upload_file', {
      ...this.target(), uid: this.uid(name, ['button', 'textbox']),
      filePaths: [attachment], allowedRoots: [dirname(attachment)],
    });
  }

  async cleanup(run: FixtureRun) {
    this.phase = 'cleanup';
    this.signal = AbortSignal.timeout(15_000);
    const listing = await this.call('list_pages', { browserId: this.browserId, signal: this.signal });
    for (const entry of parsePages(listing)) {
      if (this.ownedPages.has(entry.id) || entry.label.includes(run.runId)) {
        if (this.session.getDialog(entry.id)) {
          await this.call('handle_dialog', { ...this.target(entry.id), action: 'dismiss' });
        }
        await this.call('close_page', this.target(entry.id));
      }
    }
  }

  async saveEvidence() {
    await mkdir(this.artifactDir, { recursive: true });
    await writeFile(join(this.artifactDir, 'tools.jsonl'), this.events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  metrics() {
    return {
      toolCalls: { total: this.events.length, browser: this.events.length, failed: this.events.filter((event) => event.failed).length },
      toolTiming: this.events.map(({ input: _input, output: _output, ...timing }) => timing),
    };
  }
}

function parsePages(text: string) {
  return [...text.matchAll(/^(\d+): (.+)$/gm)].map((match) => ({ id: Number(match[1]), label: match[2]! }));
}

// Values below come from fixture/scenarios.mjs. Dynamic references are read from
// visible UI or current browser tool output, never from fixture state or oracle internals.
async function intake(ui: SourceTools) {
  await ui.wait('New service request');
  await ui.fill([
    ['Customer', 'Aster Demo Co'], ['Contact name', 'Riley Demo'],
    ['Contact email', 'riley@example.invalid'], ['Requested units', '12'],
    ['Service level', 'Express'], ['Delivery date', '2030-06-18'],
    ['High', 'true'], ['Handling notes', 'Demo launch allocation'],
    ['Include shipment insurance', 'true'], ['Send marketing updates', 'false'],
    ['I accept the service terms', 'true'],
  ]);
  await ui.click('Submit service request');
  await ui.wait('The service request is recorded and ready for stock allocation.');
}

async function inventory(ui: SourceTools) {
  await ui.wait('Apply filters');
  await ui.fill([['Region', 'East'], ['Availability', 'Ready'], ['Reserve for customer', 'Aster Demo Co']]);
  await ui.click('Apply filters');
  await ui.wait('Page 1 of');
  while (!ui.find('Reserve DEMO-042', ['button'])) {
    const pagination = ui.nodes().find((node) => /^Page \d+ of \d+/.test(node.name ?? ''));
    assert(pagination, 'The UI must expose inventory pagination');
    const current = Number(/^Page (\d+)/.exec(pagination.name ?? '')![1]);
    const next = ui.find('Next page', ['button']);
    assert(next && !next.disabled, 'DEMO-042 was not found in the filtered inventory');
    await ui.click('Next page');
    await ui.wait(`Page ${current + 1} of`);
  }
  await ui.click('Refresh stock');
  await ui.wait('Stock refreshed. Review the current row before reserving.');
  // The refreshed table has new DOM nodes; resolve its current UID before filling.
  await ui.fill([['Quantity for DEMO-042', '7']]);
  await ui.click('Reserve DEMO-042');
  await ui.wait('units of DEMO-042 allocated to Aster Demo Co.');
}

async function approvals(ui: SourceTools) {
  await ui.wait('Review note for APR-204');
  await ui.call('hover', { ...ui.target(), uid: ui.uid('Review note for APR-204', ['button']) });
  await ui.observe();
  const reviewCode = await visibleText(ui, '[data-approval="APR-204"] [role="tooltip"] strong');
  assert(reviewCode, 'The hovered finance review must expose its reference');
  await ui.click('Actions for APR-204');
  await ui.observe();
  await ui.click('Approve request', ['menuitem']);
  await ui.call('handle_dialog', { ...ui.target(), action: 'dismiss' });
  await ui.wait('Approval cancelled. APR-204 remains pending.');
  await ui.click('Approve request', ['menuitem']);
  await ui.call('handle_dialog', { ...ui.target(), action: 'accept' });
  await waitUntil(() => ui.session.getDialog(ui.pageId)?.type() === 'prompt', 'approval reason prompt');
  await ui.call('handle_dialog', { ...ui.target(), action: 'accept', promptText: reviewCode });
  // The alert appears after the approval request completes, not necessarily in the
  // same turn that accepts the prompt. Reading dialog presence does not handle it.
  await waitUntil(() => Boolean(ui.session.getDialog(ui.pageId)), 'approval notification');
  await ui.call('handle_dialog', { ...ui.target(), action: 'dismiss' });
  await ui.wait('APR-204 approved. One finance decision was recorded.');
}

async function board(ui: SourceTools, run: FixtureRun) {
  await ui.wait('Move PAR-104 to');
  await ui.observe(true);
  await ui.call('drag', {
    ...ui.target(), from_uid: ui.uid('Aster demo shipment', ['heading']),
    to_uid: ui.uid('Packed parcels', ['region']),
  });
  await ui.wait('PAR-104 moved to Packed.');
  await ui.upload('Parcel note for PAR-104', run);
  await ui.wait('parcel-note.txt attached to the packed parcel.');
  await ui.observe(true);
  await ui.call('drag', {
    ...ui.target(), from_uid: ui.uid('Aster demo shipment', ['heading']),
    to_uid: ui.uid('Dispatched parcels', ['region']),
  });
  await ui.wait('PAR-104 moved to Dispatched. Dispatch receipt recorded.');
}

async function frames(ui: SourceTools) {
  await ui.page().waitForFrame((frame) => URL.parse(frame.url())?.searchParams.get('level') === 'inner', { timeout: 10_000 });
  await ui.wait('Save routing settings');
  await ui.fill([['Route', 'ROUTE-7']]);
  await ui.observe();
  await ui.fill([
    ['Depot', 'Harbor demo depot'], ['Reorder point', '24'],
    ['Lane label', 'Demo coastal lane'], ['Temperature-controlled handling', 'true'],
  ]);
  await ui.click('Save routing settings');
  await ui.wait('Routing settings saved for ROUTE-7.');
  await ui.click('Reload routing component');
  await ui.page().waitForFrame((frame) => URL.parse(frame.url())?.searchParams.has('revision') === true, { timeout: 10_000 });
  await ui.wait('Save routing settings');
  assert.equal(ui.find('Route', ['combobox'])?.value, 'ROUTE-7');
  assert.equal(ui.find('Depot', ['combobox'])?.value, 'Harbor demo depot');
  assert.equal(String(ui.find('Reorder point', ['spinbutton'])?.value), '24');
  assert.equal(ui.find('Lane label', ['textbox'])?.value, 'Demo coastal lane');
  assert.equal(ui.find('Temperature-controlled handling', ['checkbox'])?.checked, true);
}

async function tabs(ui: SourceTools, run: FixtureRun) {
  await ui.wait('Open confirmation for PO-731');
  const originalPageId = ui.pageId;
  const seal = await visibleText(ui, '[data-order="PO-731"] dl > div:last-child dd');
  assert(seal, 'The purchase order details must show its receiving seal');
  await ui.call('list_pages', { browserId: ui.browserId });
  await ui.click('Open confirmation for PO-731');
  let popupId: number | undefined;
  await waitUntil(async () => {
    const listing = await ui.call('list_pages', { browserId: ui.browserId });
    popupId = parsePages(listing).find((entry) => entry.id !== originalPageId
      && entry.label.includes(run.runId) && entry.label.includes('orderId=PO-731'))?.id;
    return popupId !== undefined;
  }, 'receiving confirmation window');
  ui.ownedPages.add(popupId!);
  await ui.selectPage(popupId!);
  await ui.wait('Confirm receiving');
  await ui.fill([
    ['Received by', 'Morgan Demo'], ['Receiving seal', seal],
    ['Package condition', 'Good'], ['All packages were counted', 'true'],
  ]);
  await ui.click('Confirm receiving');
  await ui.wait('PO-731 received by Morgan Demo. Package condition: Good.');
  await ui.call('close_page', ui.target());
  ui.ownedPages.delete(popupId!);
  await ui.selectPage(originalPageId);
  await ui.observe();
  await ui.click('Refresh confirmations');
  await ui.wait('Receiving status refreshed from the order ledger.');
  await ui.click('Reconcile PO-731');
  await ui.wait('PO-731 reconciled with confirmation');
}

async function diagnostics(ui: SourceTools) {
  await ui.wait('Run health check');
  await ui.click('Run health check');
  await ui.wait('Health check failed. Review the connector request and console details, then retry after repair.');
  const requests = await ui.call('list_network_requests', { ...ui.target(), resourceTypes: ['fetch'] });
  const failedRequest = /^reqid=(\d+) GET \S+\/connector \[[45]\d\d\]/m.exec(requests);
  assert(failedRequest, `Browser network observations did not contain the failed connector request:\n${requests}`);
  const detail = await ui.call('get_network_request', { ...ui.target(), reqid: Number(failedRequest[1]) });
  const bodyText = /### Response Body\n([\s\S]*?)(?=\n### |\n## |$)/.exec(detail)?.[1];
  assert(bodyText, `Browser network detail did not expose its response body:\n${detail}`);
  const evidence = JSON.parse(bodyText) as { code?: string; traceId?: string };
  assert.equal(typeof evidence.code, 'string');
  assert.equal(typeof evidence.traceId, 'string');

  let consoleError: unknown;
  try {
    const messages = await ui.call('list_console_messages', { ...ui.target(), types: ['error'] });
    const message = messages.split('\n').find((line) => line.includes('Connector ') && line.includes('; trace '));
    if (!message) {
      const waived = ui.consoleEvidencePolicy === 'optional';
      ui.capabilityNotes.push({
        capability: 'console', status: 'unavailable',
        reason: waived
          ? 'Fingerprint browser does not expose console events; network evidence was verified.'
          : 'Browser console observations did not contain the connector business error event; network evidence was verified.',
      });
      assert(waived, `Browser console evidence missing for the failed connector check:\n${messages}`);
    } else {
      // An existing event must match and its detail must load, even under optional policy.
      assert(message.includes(evidence.code!) && message.includes(evidence.traceId!), 'Console event must corroborate the original network error and trace');
      const msgid = /msgid=(\d+)/.exec(message)?.[1];
      assert(msgid, `The connector console event did not expose a message ID:\n${message}`);
      const consoleDetail = await ui.call('get_console_message', { ...ui.target(), msgid: Number(msgid) });
      assert(consoleDetail.includes(evidence.code!) && consoleDetail.includes(evidence.traceId!), 'Console detail must corroborate the original network error and trace');
    }
  } catch (error) { consoleError = error; }

  await ui.click('Start latency scan');
  await ui.wait('running…');
  await ui.click('Cancel scan');
  await ui.wait('cancelled. No scan result was applied.');
  await ui.fill([['Connector route', 'Local v2']]);
  await ui.click('Save connector');
  await ui.wait('Connector configuration saved. Run a health check to verify the route.');
  await waitUntil(async () => {
    await ui.click('Run health check');
    await ui.wait([
      'Connector ready. The local v2 health check succeeded.',
      'Health check failed. Review the connector request and console details, then retry after repair.',
    ]);
    return Boolean(ui.find('Connector ready. The local v2 health check succeeded.', ['StaticText']));
  }, 'repaired connector health check');
  await ui.fill([
    ['Original error code', evidence.code!], ['Original trace ID', evidence.traceId!],
    ['Resolution note', 'Demo connector migrated'],
  ]);
  await ui.click('File resolution');
  await ui.wait('resolved. The original failure evidence and repair note were recorded.');
  // Keep exercising cancellation and repair when console collection is broken,
  // but report the source-tool failure even if the business oracle now passes.
  if (consoleError) throw consoleError;
}

async function journey(ui: SourceTools, run: FixtureRun) {
  await ui.wait('Open Service intake');
  await ui.click('Open Service intake');
  await intake(ui);
  await ui.click('Continue to stock allocation');
  await inventory(ui);
  await ui.click(/Dispatch board$/, ['link']);
  await board(ui, run);
  await ui.click(/Receiving windows$/, ['link']);
  await tabs(ui, run);
  await ui.click(/Order overview$/, ['link']);
  await ui.wait('Finalize order');
  await ui.click('Finalize order');
  await ui.wait('The finalized order links every fulfillment record.');
  const references = await ui.page().$$eval('[aria-label="Final order record"] dd', (elements) => elements.map((element) => element.textContent?.trim()));
  assert.equal(references.length, 5);
  assert(references.every(Boolean), 'The final UI receipt must link all fulfillment records');
}

async function visibleText(ui: SourceTools, selector: string) {
  return ui.page().$eval(selector, (element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (style.visibility !== 'visible' || style.display === 'none' || !box.width || !box.height) {
      throw new Error('The requested business reference is not visible in the UI');
    }
    return element.textContent?.trim() ?? '';
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = performance.now() + 10_000;
  do {
    if (await predicate()) return;
    await delay(50);
  } while (performance.now() < deadline);
  throw new DOMException(`Timed out waiting for ${label}`, 'TimeoutError');
}

export async function runCoreScenario(ui: SourceTools, run: FixtureRun) {
  await ui.open(run);
  switch (run.scenarioId) {
    case 'intake': return intake(ui);
    case 'inventory': return inventory(ui);
    case 'approvals': return approvals(ui);
    case 'board': return board(ui, run);
    case 'frames': return frames(ui);
    case 'tabs': return tabs(ui, run);
    case 'diagnostics': return diagnostics(ui);
    case 'journey': return journey(ui, run);
    default: throw new Error(`No source-tool adapter for scenario ${run.scenarioId}`);
  }
}
