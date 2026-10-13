/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/tools/{pages,input,snapshot,
 * screenshot,script,console,network}.ts, src/McpResponse.ts (default text),
 * and src/utils/url.ts. Browser execution, feedback and file access use the host.
 */

import { BrowserManager } from '../../core/browser/browser-manager.js';
import {
  BrowserOperations,
  type BrowserNavigateRequest,
  type BrowserWindowBoundsInput,
} from '../../core/browser/browser-operations.js';
import type { ActionReceipt } from '../../core/session/action-waiter.js';
import type { BrowserAutomationSession } from '../../core/session/browser-automation-session.js';
import { CLOSE_PAGE_ERROR } from '../../core/session/page-registry.js';
import { validatePathWithinRoots } from '../../core/session/file-roots.js';
import {
  saveObservationFile,
  validateObservationFile,
  type ObservationFileOptions,
} from '../../core/session/observation-files.js';
import {
  listConsoleMessages,
  getConsoleMessage,
  listNetworkRequests,
  getNetworkRequest,
  resolveCdpRequestId,
  type ConsoleDataDependencies,
  type ConsoleListOptions,
  type NetworkListOptions,
} from '../../core/session/page-data.js';
import {
  takeScreenshot,
  type ScreenshotOptions,
  type ScreenshotResult,
} from '../../core/session/screenshot.js';
import {
  evaluateScript,
  type ScriptEvaluationOptions,
} from '../../core/session/script-evaluation.js';
import { formatTextSnapshot } from '../../core/session/text-snapshot.js';

interface BrowserCallContext {
  browserId: string;
  signal?: AbortSignal;
}
interface PageCallContext extends BrowserCallContext {
  pageId: number;
}
interface FileCallContext {
  files: ObservationFileOptions;
}
interface SnapshotOption {
  includeSnapshot?: boolean;
}

export async function list_pages(params: BrowserCallContext): Promise<string> {
  return runBrowserCore(params, formatPages);
}

export async function new_page(params: BrowserCallContext & {
  url: string;
  background?: boolean;
  isolatedContext?: string;
  timeout?: number;
}): Promise<string> {
  return runBrowserCore(params, async (automation) => {
    validateNavigationUrl(params.url);
    await automation.newPage(params.url, normalizeTimeout(params.timeout), {
      background: params.background,
      isolatedContext: params.isolatedContext,
    });
    return formatPages(automation);
  });
}

export async function select_page(params: PageCallContext & {
  bringToFront?: boolean;
}): Promise<string> {
  return runBrowserCore(params, async (automation) => {
    await automation.selectPageById(params.pageId, params.bringToFront ?? false);
    return formatPages(automation);
  });
}

export async function close_page(params: PageCallContext): Promise<string> {
  return runBrowserCore(params, async (automation) => {
    let message = '';
    try {
      await automation.closePageById(params.pageId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== CLOSE_PAGE_ERROR) throw error;
      message = error.message;
    }
    return joinLines(message, await formatPages(automation));
  });
}

export async function navigate_page(params: PageCallContext & Omit<
  BrowserNavigateRequest, 'browserId' | 'signal' | 'pageId'
>): Promise<string> {
  return runPageCore(params, async (automation) => {
    const { pageId, type, url, ignoreCache, handleBeforeUnload, initScript, timeout } = params;
    if (url) validateNavigationUrl(url);
    const result = await actionWithDialog(automation, pageId, () => BrowserOperations.navigateInSession(automation, {
      pageId, type, url, ignoreCache, handleBeforeUnload, initScript, timeout: normalizeTimeout(timeout),
    }));
    return finalize(automation, params.pageId, joinLines(result.message, result.receipt.dialogHandled
      ? `${params.handleBeforeUnload === 'dismiss' ? 'Dismissed' : 'Accepted'} a beforeunload dialog.`
      : ''), { pages: true });
  }, { feedback: true, blockedByDialog: false });
}

export async function take_snapshot(params: PageCallContext & FileCallContext & {
  verbose?: boolean;
  filePath?: string;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    // File access is checked before starting a new observation.
    if (params.filePath) await validateObservationFile(params.filePath, '.txt', params.files);
    const snapshot = await automation.takeSnapshot(params.verbose ?? false, params.pageId);
    const text = formatTextSnapshot(snapshot);
    if (params.filePath) {
      const { filename } = await saveObservationFile(
        new TextEncoder().encode(text), params.filePath, '.txt', params.files,
      );
      return finalize(automation, params.pageId, `Saved snapshot to ${filename}.`);
    }
    return finalize(automation, params.pageId, '', { snapshotText: text });
  });
}

export async function click(params: PageCallContext & SnapshotOption & {
  uid: string;
  dblClick?: boolean;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    const receipt = await actionWithDialog(automation, params.pageId, () => automation.clickByUid(params.uid, params.dblClick ? 2 : 1, params.pageId));
    if (receipt.interrupted) {
      return finalize(automation, params.pageId, params.dblClick
        ? 'The element was double clicked and it opened a dialog.'
        : 'The element was clicked and it opened a dialog.');
    }
    return finalize(automation, params.pageId, params.dblClick
      ? 'Successfully double clicked on the element'
      : 'Successfully clicked on the element', { receipt, snapshot: params.includeSnapshot });
  }, { feedback: true });
}

export async function hover(params: PageCallContext & SnapshotOption & {
  uid: string;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    const receipt = await actionWithDialog(automation, params.pageId, () => automation.hoverByUid(params.uid, params.pageId));
    if (receipt.interrupted) {
      return finalize(automation, params.pageId, 'The element was hovered and it opened a dialog.');
    }
    return finalize(automation, params.pageId, 'Successfully hovered over the element', {
      receipt, snapshot: params.includeSnapshot,
    });
  }, { feedback: true });
}

export async function fill(params: PageCallContext & SnapshotOption & {
  uid: string;
  value: string;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    const receipt = await actionWithDialog(automation, params.pageId, () => automation.fillByUid(params.uid, params.value, params.pageId));
    if (receipt.interrupted) {
      return finalize(automation, params.pageId, 'The element was filled out and it opened a dialog.');
    }
    return finalize(automation, params.pageId, 'Successfully filled out the element', {
      receipt, snapshot: params.includeSnapshot,
    });
  }, { feedback: true });
}

export async function fill_form(params: PageCallContext & SnapshotOption & {
  elements: Array<{ uid: string; value: string }>;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    const receipt = await actionWithDialog(automation, params.pageId, () => automation.fillFormByUids(params.elements, params.pageId));
    if (receipt.interrupted) {
      const hasRemainingElements = receipt.interruptedUid !== params.elements.at(-1)?.uid;
      return finalize(automation, params.pageId,
        `Filling out the element with uid ${receipt.interruptedUid} opened a dialog.${
          hasRemainingElements ? ' The remaining elements were not filled out.' : ''
        }`);
    }
    return finalize(automation, params.pageId, 'Successfully filled out the form', {
      receipt, snapshot: params.includeSnapshot,
    });
  }, { feedback: true });
}

export async function type_text(params: PageCallContext & {
  text: string;
  submitKey?: string;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    const receipt = await actionWithDialog(automation, params.pageId, () => automation.typeText(params.text, params.submitKey, params.pageId));
    return finalize(automation, params.pageId,
      `Typed text "${params.text}${params.submitKey ? ` + ${params.submitKey}` : ''}"`, { receipt });
  }, { feedback: true });
}

export async function press_key(params: PageCallContext & SnapshotOption & {
  key: string;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    const receipt = await actionWithDialog(automation, params.pageId, () => automation.pressKey(params.key, params.pageId));
    return finalize(automation, params.pageId, `Successfully pressed key: ${params.key}`, {
      receipt, snapshot: params.includeSnapshot,
    });
  }, { feedback: true });
}

export async function drag(params: PageCallContext & SnapshotOption & {
  from_uid: string;
  to_uid: string;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    const receipt = await actionWithDialog(automation, params.pageId, () => automation.dragByUids(params.from_uid, params.to_uid, params.pageId));
    return finalize(automation, params.pageId, 'Successfully dragged an element', {
      receipt, snapshot: params.includeSnapshot,
    });
  }, { feedback: true });
}

export async function upload_file(params: PageCallContext & SnapshotOption & {
  uid: string;
  filePaths: string[];
  allowedRoots: readonly string[];
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    for (const filePath of params.filePaths) await validatePathWithinRoots(filePath, params.allowedRoots);
    await actionWithDialog(automation, params.pageId, () => automation.uploadFileByUid(params.uid, params.filePaths, params.pageId));
    return finalize(automation, params.pageId, `File uploaded from ${params.filePaths.join(', ')}.`, {
      snapshot: params.includeSnapshot,
    });
  }, { feedback: true });
}

export async function wait_for(params: PageCallContext & {
  text: string[];
  timeout?: number;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    await actionWithDialog(automation, params.pageId, () => automation.waitForTextOnPage(params.text, normalizeTimeout(params.timeout), params.pageId));
    return finalize(automation, params.pageId,
      `Element matching one of ${JSON.stringify(params.text)} found.`, { snapshot: true });
  });
}

export async function handle_dialog(params: PageCallContext & {
  action: 'accept' | 'dismiss';
  promptText?: string;
}): Promise<string> {
  return runPageCore(params, async (automation) => {
    await actionWithDialog(automation, params.pageId, () => automation.handleDialog(params.action, params.promptText, params.pageId));
    return finalize(automation, params.pageId, params.action === 'accept'
      ? 'Successfully accepted the dialog'
      : 'Successfully dismissed the dialog', { pages: true });
  }, { blockedByDialog: false });
}

export async function take_screenshot(
  params: PageCallContext & FileCallContext & ScreenshotOptions,
): Promise<ScreenshotResult> {
  return runPageCore(params, async (automation) => {
    const result = await actionWithDialog(automation, params.pageId, () => takeScreenshot(automation.getPage(params.pageId), params, {
      resolveUid: (uid) => automation.getElementByUid(uid, params.pageId),
      files: params.files,
      signal: params.signal,
    }));
    return { ...result, text: await finalize(automation, params.pageId, result.text) };
  });
}

export async function evaluate_script(
  params: PageCallContext & FileCallContext & ScriptEvaluationOptions,
): Promise<string> {
  // The source uses defineTool: route the action, but do not bind response dialog state.
  return BrowserManager.runExclusive(params.browserId, async ({ automation }) => {
    const result = await evaluateScript(automation.getPageById(params.pageId), params, {
      resolveUid: (uid) => automation.getElementByUid(uid, params.pageId),
      waitForAction: (action, options) => automation.waitForAction(action, {
        ...options, pageId: params.pageId,
      }),
      files: params.files,
      signal: params.signal,
    });
    return joinLines(result.text, navigationFeedback(result.receipt));
  }, params.signal, { pageId: params.pageId, feedback: true });
}

export async function list_console_messages(
  params: PageCallContext & FileCallContext & ConsoleListOptions,
): Promise<string> {
  return runPageCore(params, async (automation) => finalize(automation, params.pageId,
    (await listConsoleMessages(automation.getConsoleCollector(params.pageId), params,
      consoleDependencies(automation, params.pageId, params.files))).text), { blockedByDialog: false });
}

export async function get_console_message(params: PageCallContext & FileCallContext & {
  msgid: number;
}): Promise<string> {
  return runPageCore(params, async (automation) => finalize(automation, params.pageId,
    (await getConsoleMessage(automation.getConsoleCollector(params.pageId), params.msgid,
      consoleDependencies(automation, params.pageId, params.files))).text),
  { blockedByDialog: false });
}

export async function list_network_requests(
  params: PageCallContext & NetworkListOptions,
): Promise<string> {
  return runPageCore(params, async (automation) => finalize(automation, params.pageId,
    (await listNetworkRequests(
      automation.getPage(params.pageId), automation.getNetworkCollector(params.pageId), params,
    )).text), { blockedByDialog: false });
}

export async function get_network_request(params: PageCallContext & FileCallContext & {
  reqid?: number;
  requestFilePath?: string;
  responseFilePath?: string;
}): Promise<string> {
  return runPageCore(params, async (automation) => finalize(automation, params.pageId,
    (await getNetworkRequest(
      automation.getPage(params.pageId), automation.getNetworkCollector(params.pageId), params, params.files,
    )).text));
}

export async function closeBrowser(params: { browserId: string }): Promise<string> {
  await BrowserOperations.close(params.browserId);
  return `Browser ${params.browserId} closed successfully`;
}

export async function getAllCookies(params: BrowserCallContext & {
  urls?: string[];
}): Promise<string> {
  return JSON.stringify(await BrowserOperations.getAllCookies(params), null, 2);
}

export async function setCookies(params: BrowserCallContext & {
  cookies: Record<string, unknown>[];
}): Promise<string> {
  if (!Array.isArray(params.cookies)) throw new Error('setCookies: params.cookies 必须是数组');
  return JSON.stringify(await BrowserOperations.setCookies(params), null, 2);
}

export async function deleteCookies(params: BrowserCallContext & {
  cookies: Record<string, unknown>[];
}): Promise<string> {
  if (!Array.isArray(params.cookies)) throw new Error('deleteCookies: params.cookies 必须是数组');
  return JSON.stringify(await BrowserOperations.deleteCookies(params), null, 2);
}

export async function clearCookies(params: BrowserCallContext): Promise<string> {
  return JSON.stringify(await BrowserOperations.clearCookies(params.browserId, params.signal), null, 2);
}

export async function getWindowBounds(params: BrowserCallContext): Promise<string> {
  const bounds = await BrowserOperations.getWindowBounds(params.browserId, params.signal);
  return JSON.stringify({ success: true, bounds }, null, 2);
}

export async function setWindowBounds(params: BrowserCallContext & {
  bounds: BrowserWindowBoundsInput;
}): Promise<string> {
  if (!params.bounds || typeof params.bounds !== 'object') {
    throw new Error('setWindowBounds: params.bounds 必须是对象');
  }
  const bounds = await BrowserOperations.setWindowBounds(params.browserId, params.bounds, params.signal);
  return JSON.stringify({ success: true, bounds }, null, 2);
}

function consoleDependencies(
  automation: BrowserAutomationSession,
  pageId: number,
  files: ObservationFileOptions,
): ConsoleDataDependencies {
  return {
    files,
    serviceWorkers: automation.getServiceWorkerConsoleCollector(),
    requestIdResolver: (cdpRequestId) => resolveCdpRequestId(automation.getNetworkCollector(pageId), cdpRequestId),
    elementIdResolver: (backendNodeId) => {
      const snapshot = automation.getActiveSnapshot(pageId);
      for (const node of snapshot?.idToNode.values() ?? []) {
        if (node.backendNodeId === backendNodeId) return node.id;
      }
      return undefined;
    },
  };
}

function runBrowserCore<T>(
  { browserId, signal }: BrowserCallContext,
  action: (automation: BrowserAutomationSession) => Promise<T>,
  feedback = false,
): Promise<T> {
  return BrowserManager.runExclusive(browserId, ({ automation }) => action(automation), signal, { feedback });
}

function runPageCore<T>(
  params: PageCallContext,
  action: (automation: BrowserAutomationSession) => Promise<T>,
  options: { feedback?: boolean; blockedByDialog?: boolean } = {},
): Promise<T> {
  return BrowserManager.runExclusive(params.browserId, async ({ automation }) => {
    if (options.blockedByDialog !== false) {
      await actionWithDialog(automation, params.pageId, () => automation.throwIfDialogOpen(params.pageId));
    }
    return action(automation);
  }, params.signal, { pageId: params.pageId, feedback: options.feedback ?? false });
}

/** Handler errors retain response-page dialog text; observation failures propagate separately. */
async function actionWithDialog<T>(
  automation: BrowserAutomationSession,
  pageId: number,
  action: () => Promise<T> | T,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const dialog = formatOpenDialog(automation, pageId);
    if (!dialog) throw error;
    throw new Error(joinLines(error instanceof Error ? error.message : String(error), dialog), {
      ...(error instanceof Error && error.cause !== undefined ? { cause: error.cause } : {}),
    });
  }
}

async function finalize(
  automation: BrowserAutomationSession,
  pageId: number,
  message: string,
  options: {
    receipt?: ActionReceipt;
    snapshot?: boolean;
    snapshotText?: string;
    pages?: boolean;
  } = {},
): Promise<string> {
  const snapshotText = options.snapshot
    ? formatTextSnapshot(await automation.takeSnapshot(false, pageId))
    : options.snapshotText;
  return joinLines(
    message,
    options.receipt ? navigationFeedback(options.receipt) : '',
    formatOpenDialog(automation, pageId),
    options.pages ? await formatPages(automation) : '',
    snapshotText !== undefined ? `## Latest page snapshot\n${snapshotText}` : '',
  );
}

function formatOpenDialog(automation: BrowserAutomationSession, pageId: number): string {
  const dialog = automation.getDialog(pageId);
  if (!dialog) return '';
  const defaultValue = dialog.type() === 'prompt' ? ` (default value: "${dialog.defaultValue()}")` : '';
  return `# Open dialog\n${dialog.type()}: ${dialog.message()}${defaultValue}.\n`
    + 'Call handle_dialog to handle it before continuing.';
}

async function formatPages(automation: BrowserAutomationSession): Promise<string> {
  const pages = await automation.listPages();
  const selected = pages.length ? automation.getSelectedPageId() : undefined;
  const lines: string[] = [];
  const fallback = automation.consumeSelectedPageFallback();
  if (fallback) lines.push(`Note: the previously selected page ${fallback.wasClosed ? 'was closed' : 'is no longer listed'}.${selected !== undefined ? ` Page ${selected} is now selected.` : ''}`);
  if (pages.length) lines.push('## Pages');
  for (const { pageId, page, isolatedContextName } of pages) {
    const title = await fetchPageTitle(page);
    const label = title ? `${truncateTitle(title)} (${page.url()})` : page.url();
    lines.push(`${pageId}: ${label}${pageId === selected ? ' [selected]' : ''}${
      isolatedContextName ? ` isolatedContext=${isolatedContextName}` : ''
    }`);
  }
  return lines.join('\n');
}

async function fetchPageTitle(page: { title(): Promise<string> }): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.title().catch(() => ''),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), 1_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function truncateTitle(title: string): string {
  return title.length <= 50 ? title : title.slice(0, 47) + '...';
}

function navigationFeedback(receipt: ActionReceipt): string {
  return receipt.navigatedToUrl ? `Page navigated to ${receipt.navigatedToUrl}.` : '';
}

function normalizeTimeout(value: number | undefined): number | undefined {
  return value !== undefined && value <= 0 ? undefined : value;
}

function joinLines(...parts: string[]): string {
  return parts.filter(Boolean).join('\n');
}

/** Fixed source validation with JavaScript enabled and extension tools disabled. */
function validateNavigationUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error(`Invalid URL: "${url}". URLs must be valid according to the URL standard.`); }
  if (parsed.protocol === 'chrome-extension:') {
    throw new Error('Navigating to chrome-extension: URLs is not allowed without --categoryExtensions.');
  }
  if (parsed.protocol === 'chrome:') {
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (['newtab', 'new-tab-page', 'inspect'].includes(host)
      || (host === '' && (path === 'newtab' || path === 'new-tab-page' || path.startsWith('inspect')))) return;
  }
  if (parsed.protocol === 'chrome:' || parsed.protocol === 'chrome-untrusted:') {
    throw new Error(`Navigating to ${parsed.protocol} URLs is not allowed.`);
  }
}
