/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * chrome-devtools-mcp 1.7.0 input, page, snapshot, screenshot, and script
 * behaviors are exposed through Piskie's browser contract.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementHandle } from 'puppeteer-core';
import { BrowserManager } from '../../core/browser/browser-manager.js';
import {
  BrowserOperations,
  type BrowserNavigateRequest,
  type BrowserNavigationResult,
  type BrowserWindowBoundsInput,
} from '../../core/browser/browser-operations.js';
import type { BrowserAutomationSession } from '../../core/session/browser-automation-session.js';
import {
  CLOSE_PAGE_ERROR,
  type PageChangeSet,
} from '../../core/session/page-registry.js';
import { ConsoleFormatter } from '../../core/session/console-formatter.js';
import { validatePathWithinRoots } from '../../core/session/file-roots.js';
import { NetworkFormatter } from '../../core/session/network-formatter.js';
import { formatPagination, type PaginationOptions } from '../../core/session/pagination.js';
import {
  formatTextSnapshot,
  type TextSnapshotResult,
} from '../../core/session/text-snapshot.js';

export type ConsoleMessageFilter =
  | 'log'
  | 'debug'
  | 'info'
  | 'error'
  | 'warn'
  | 'dir'
  | 'dirxml'
  | 'table'
  | 'trace'
  | 'clear'
  | 'startGroup'
  | 'startGroupCollapsed'
  | 'endGroup'
  | 'assert'
  | 'profile'
  | 'profileEnd'
  | 'count'
  | 'timeEnd'
  | 'verbose';

export type NetworkResourceFilter =
  | 'document'
  | 'stylesheet'
  | 'image'
  | 'media'
  | 'font'
  | 'script'
  | 'texttrack'
  | 'xhr'
  | 'fetch'
  | 'prefetch'
  | 'eventsource'
  | 'websocket'
  | 'manifest'
  | 'signedexchange'
  | 'ping'
  | 'cspviolationreport'
  | 'preflight'
  | 'fedcm'
  | 'other';

export async function takeSnapshot(params: {
  verbose?: boolean;
  browserId: string;
}): Promise<string> {
  return BrowserManager.runExclusive(params.browserId, async ({ automation }) => {
    return formatStandaloneSnapshot(await automation.takeSnapshot(params.verbose ?? false));
  });
}

export async function clickByUid(params: {
  uid: string;
  clickCount?: number;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await automation.clickByUid(params.uid, params.clickCount === 2 ? 2 : 1);
    return finalize(automation, 'Successfully ' +
      (params.clickCount === 2 ? 'double clicked on the element' : 'clicked on the element'), {
      snapshot: true,
    });
  });
}

export async function fillByUid(params: {
  uid: string;
  value: string;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await automation.fillByUid(params.uid, params.value);
    return finalize(automation, 'Successfully filled out the element', { snapshot: true });
  });
}

export type NavigateToParams = BrowserNavigateRequest;

export async function navigateTo(params: NavigateToParams): Promise<string> {
  const { browserId, signal, ...request } = params;
  return runBrowserCore(browserId, signal, async (automation) => {
    const result = await BrowserOperations.navigateInSession(automation, request);
    return finalize(automation, navigationMessage(result, request.url), { pages: true });
  });
}

export async function goBack(params: { browserId: string }): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    const page = automation.getSelectedPage();
    await automation.waitForAction(() => page.goBack({ waitUntil: 'networkidle2' }));
    const snapshot = await automation.takeSnapshot(false);
    return `Went back\n\n${formatStandaloneSnapshot(snapshot)}`;
  });
}

export async function refresh(params: { browserId: string }): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    const page = automation.getSelectedPage();
    await automation.waitForAction(() => page.reload({ waitUntil: 'networkidle2' }));
    const snapshot = await automation.takeSnapshot(false);
    return `Page refreshed\n\n${formatStandaloneSnapshot(snapshot)}`;
  });
}

export async function newPage(params: {
  url: string;
  timeout?: number;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await automation.newPage(params.url, params.timeout);
    return finalize(automation, '', { pages: true });
  });
}

export async function closePage(params: {
  pageIndex: number;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    let message = '';
    try {
      await automation.closePageByIndex(params.pageIndex);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== CLOSE_PAGE_ERROR) {
        throw error;
      }
      message = error.message;
    }
    return finalize(automation, message, { pages: true });
  });
}

export async function listPages(params: { browserId: string }): Promise<string> {
  return runBrowserCore(params.browserId, undefined, (automation) =>
    finalize(automation, '', { pages: true })
  );
}

export async function selectPage(params: {
  pageIdx: number;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await automation.selectPageByIndex(params.pageIdx);
    return finalize(automation, '', { pages: true });
  });
}

export async function pressKey(params: {
  key: string;
  count?: number;
  browserId: string;
}): Promise<string> {
  const count = params.count ?? 1;
  let output = '';
  for (let index = 0; index < count; index += 1) {
    output = await runBrowserCore(params.browserId, undefined, async (automation) => {
      await automation.pressKey(params.key);
      return finalize(automation, `Successfully pressed key: ${params.key}`, { snapshot: true });
    });
  }
  return output;
}

export async function hoverByUid(params: {
  uid: string;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await automation.hoverByUid(params.uid);
    return finalize(automation, 'Successfully hovered over the element', { snapshot: true });
  });
}

export async function drag(params: {
  fromUid: string;
  toUid: string;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await automation.dragByUids(params.fromUid, params.toUid);
    return finalize(automation, 'Successfully dragged an element', { snapshot: true });
  });
}

export async function uploadFile(params: {
  uid: string;
  filePath: string;
  allowedRoots: readonly string[];
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await validatePathWithinRoots(params.filePath, params.allowedRoots);
    await automation.uploadFileByUid(params.uid, params.filePath);
    return finalize(automation, `File uploaded from ${params.filePath}.`, { snapshot: true });
  });
}

export async function fillFormByUids(params: {
  elements: Array<{ uid: string; value: string }>;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await automation.fillFormByUids(params.elements);
    return finalize(automation, 'Successfully filled out the form', { snapshot: true });
  });
}

export async function handleDialog(params: {
  action: 'accept' | 'dismiss';
  promptText?: string;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await automation.handleDialog(params.action, params.promptText);
    const message = params.action === 'accept'
      ? 'Successfully accepted the dialog'
      : 'Successfully dismissed the dialog';
    return finalize(automation, message, { pages: true });
  });
}

export async function waitFor(params: {
  text: string[];
  timeout?: number;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    await automation.waitForTextOnPage(params.text, params.timeout);
    return finalize(
      automation,
      `Element matching one of ${JSON.stringify(params.text)} found.`,
      { snapshot: true },
    );
  });
}

export async function listConsoleMessages(params: {
  pageSize?: number;
  pageIdx?: number;
  types?: ConsoleMessageFilter[];
  includePreservedMessages?: boolean;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    let messages = automation.getConsoleData(params.includePreservedMessages ?? false);
    if (params.types?.length) {
      const types = new Set(params.types);
      messages = messages.filter((message) => (
        message instanceof Error ? types.has('error') : types.has(message.type())
      ));
    }
    const formatted = await Promise.all(messages.map((message) => ConsoleFormatter.from(message, {
      id: automation.getConsoleMessageId(message),
    })));
    const grouped = ConsoleFormatter.groupConsecutive(formatted);
    if (grouped.length === 0) return '## Console messages\n<no console messages found>';

    const page = formatPagination(grouped, paginationOptions(params));
    return ['## Console messages', ...page.info, ...page.items.map((item) => item.toString())]
      .join('\n');
  });
}

export async function getConsoleMessage(params: {
  msgid: number;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    const message = automation.getConsoleMessageById(params.msgid);
    const formatter = await ConsoleFormatter.from(message, {
      id: params.msgid,
      fetchDetailedData: true,
    });
    return formatter.toStringDetailed();
  });
}

export async function listNetworkRequests(params: {
  pageSize?: number;
  pageIdx?: number;
  resourceTypes?: NetworkResourceFilter[];
  includePreservedRequests?: boolean;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    let requests = automation.getNetworkRequests(params.includePreservedRequests ?? false);
    if (params.resourceTypes?.length) {
      const resourceTypes = new Set(params.resourceTypes);
      requests = requests.filter((request) => resourceTypes.has(request.resourceType()));
    }
    if (requests.length === 0) return '## Network requests\nNo requests found.';

    const formatted = await Promise.all(requests.map((request) => NetworkFormatter.from(request, {
      requestId: automation.getNetworkRequestId(request),
    })));
    const page = formatPagination(formatted, paginationOptions(params));
    return ['## Network requests', ...page.info, ...page.items.map((item) => item.toString())]
      .join('\n');
  });
}

export async function getNetworkRequest(params: {
  reqid?: number;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    automation.throwIfDialogOpen();
    if (!params.reqid) return 'Nothing is currently selected in the DevTools Network panel.';
    const request = automation.getNetworkRequestById(params.reqid);
    const formatter = await NetworkFormatter.from(request, {
      requestId: params.reqid,
      requestIdResolver: (redirect) => automation.getNetworkRequestId(redirect),
      fetchData: true,
    });
    return formatter.toStringDetailed();
  });
}

export async function takeScreenshot(params: {
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  uid?: string;
  fullPage?: boolean;
  browserId: string;
}): Promise<string> {
  const format = params.format ?? 'png';
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    if (params.uid && params.fullPage) {
      throw new Error('Providing both "uid" and "fullPage" is not allowed.');
    }
    let target: ElementHandle<Element> | ReturnType<typeof automation.getSelectedPage>;
    let element: ElementHandle<Element> | undefined;
    if (params.uid) {
      element = await automation.getElementByUid(params.uid);
      target = element;
    } else {
      target = automation.getSelectedPage();
    }
    try {
      const image = await target.screenshot({
        type: format,
        ...(params.fullPage ? { fullPage: true } : {}),
        ...(format !== 'png' && params.quality !== undefined ? { quality: params.quality } : {}),
        optimizeForSpeed: true,
      });
      let message = params.uid
        ? `Took a screenshot of node with uid "${params.uid}".`
        : params.fullPage
          ? 'Took a screenshot of the full current page.'
          : "Took a screenshot of the current page's viewport.";
      if (image.byteLength >= 2_000_000) {
        const directory = await mkdtemp(join(tmpdir(), 'piskie-browser-screenshot-'));
        const filename = join(directory, `screenshot.${format}`);
        await writeFile(filename, image);
        message += `\nSaved screenshot to ${filename}.`;
      }
      return appendPageChanges(automation, message);
    } finally {
      void element?.dispose();
    }
  });
}

export async function evaluateScript(params: {
  function: string;
  browserId: string;
}): Promise<string> {
  return runBrowserCore(params.browserId, undefined, async (automation) => {
    const page = automation.getSelectedPage();
    const functionHandle = await page.evaluateHandle(`(${params.function})`);
    try {
      let serialized: string | undefined;
      await automation.waitForAction(async () => {
        serialized = await page.evaluate(async (candidate) => {
          // @ts-expect-error The upstream contract requires a function expression.
          return JSON.stringify(await candidate());
        }, functionHandle);
      });
      const message = `Script ran on page and returned:\n\`\`\`json\n${serialized}\n\`\`\``;
      return appendPageChanges(automation, message);
    } finally {
      void functionHandle.dispose();
    }
  });
}

export async function closeBrowser(params: { browserId: string }): Promise<string> {
  await BrowserOperations.close(params.browserId);
  return `Browser ${params.browserId} closed successfully`;
}

export async function getAllCookies(params: {
  browserId: string;
  urls?: string[];
}): Promise<string> {
  return JSON.stringify(await BrowserOperations.getAllCookies(params), null, 2);
}

export async function setCookies(params: {
  browserId: string;
  cookies: Record<string, unknown>[];
}): Promise<string> {
  if (!Array.isArray(params.cookies)) throw new Error('setCookies: params.cookies 必须是数组');
  return JSON.stringify(await BrowserOperations.setCookies(params), null, 2);
}

export async function deleteCookies(params: {
  browserId: string;
  cookies: Record<string, unknown>[];
}): Promise<string> {
  if (!Array.isArray(params.cookies)) throw new Error('deleteCookies: params.cookies 必须是数组');
  return JSON.stringify(await BrowserOperations.deleteCookies(params), null, 2);
}

export async function clearCookies(params: { browserId: string }): Promise<string> {
  return JSON.stringify(await BrowserOperations.clearCookies(params.browserId), null, 2);
}

export async function getWindowBounds(params: { browserId: string }): Promise<string> {
  const bounds = await BrowserOperations.getWindowBounds(params.browserId);
  return JSON.stringify({ success: true, bounds }, null, 2);
}

export async function setWindowBounds(params: {
  browserId: string;
  bounds: BrowserWindowBoundsInput;
}): Promise<string> {
  if (!params.bounds || typeof params.bounds !== 'object') {
    throw new Error('setWindowBounds: params.bounds 必须是对象');
  }
  const bounds = await BrowserOperations.setWindowBounds(params.browserId, params.bounds);
  return JSON.stringify({ success: true, bounds }, null, 2);
}

async function runBrowserCore<T>(
  browserId: string,
  signal: AbortSignal | undefined,
  action: (automation: BrowserAutomationSession) => Promise<T>
): Promise<T> {
  return BrowserManager.runExclusive(browserId, ({ automation }) => action(automation), signal);
}

async function finalize(
  automation: BrowserAutomationSession,
  message: string,
  options: Readonly<{ snapshot?: boolean; pages?: boolean }>
): Promise<string> {
  let output = message;
  if (options.snapshot) {
    const snapshot = await automation.takeSnapshot(false);
    output += `${output ? '\n\n' : ''}## Page Snapshot\n${formatEmbeddedSnapshot(snapshot)}`;
  }
  if (options.pages) {
    output += `\n\n${await formatPages(automation)}`;
  }
  return appendPageChanges(automation, output);
}

async function appendPageChanges(
  automation: BrowserAutomationSession,
  output: string
): Promise<string> {
  const changes = await automation.consumePageChanges();
  const rendered = await formatPageChanges(automation, changes);
  return rendered ? `${output}${output ? '\n\n' : ''}${rendered}` : output;
}

async function formatPages(automation: BrowserAutomationSession): Promise<string> {
  const pages = await automation.listPages();
  const selected = automation.getSelectedPageIndex();
  const lines = ['## Pages'];
  pages.forEach((entry, index) => {
    lines.push(`${index}: ${entry.page.url()}${index === selected ? ' [selected]' : ''}`);
  });
  return lines.join('\n') + '\n';
}

async function formatPageChanges(
  automation: BrowserAutomationSession,
  changes: PageChangeSet
): Promise<string> {
  if (changes.opened.length === 0 && changes.closed.length === 0) return '';
  const lines: string[] = [];
  if (changes.opened.length) {
    lines.push(`🆕 New page(s) opened (${changes.opened.length}):`);
    for (const page of changes.opened) lines.push(`  - [${page.pageIndex}] ${page.url}`);
  }
  if (changes.closed.length) {
    lines.push(`🔒 Page(s) closed (${changes.closed.length}):`);
    for (const page of changes.closed) lines.push(`  - [${page.pageIndex}] ${page.url}`);
  }
  const totalAfter = (await automation.listPages()).length;
  const totalBefore = totalAfter - changes.opened.length + changes.closed.length;
  lines.push(`📊 Total pages: ${totalBefore} → ${totalAfter}`);
  return lines.join('\n');
}

function navigationMessage(result: BrowserNavigationResult, requestedUrl?: string): string {
  let message: string;
  if (result.error !== undefined) {
    switch (result.type) {
      case 'url':
        message = `Unable to navigate in the selected page: ${result.error}.`;
        break;
      case 'back':
        message = `Unable to navigate back in the selected page: ${result.error}.`;
        break;
      case 'forward':
        message = `Unable to navigate forward in the selected page: ${result.error}.`;
        break;
      case 'reload':
        message = `Unable to reload the selected page: ${result.error}.`;
        break;
    }
  } else {
    switch (result.type) {
      case 'url':
        message = `Successfully navigated to ${requestedUrl ?? result.url}.`;
        break;
      case 'back':
        message = `Successfully navigated back to ${result.url}.`;
        break;
      case 'forward':
        message = `Successfully navigated forward to ${result.url}.`;
        break;
      case 'reload':
        message = 'Successfully reloaded the page.';
        break;
    }
  }
  if (result.receipt.dialog?.handled && result.receipt.dialog.type === 'beforeunload') {
    message += '\nAccepted a beforeunload dialog.';
  }
  return message;
}

function formatStandaloneSnapshot(snapshot: TextSnapshotResult): string {
  return [
    `# Page Snapshot (ID: ${snapshot.snapshotId})`,
    '',
    '## Element Tree',
    '```',
    formatTextSnapshot(snapshot).trimEnd(),
    '```',
  ].join('\n');
}

function formatEmbeddedSnapshot(snapshot: TextSnapshotResult): string {
  const formatNode = (node: TextSnapshotResult['root'], depth: number): string => {
    const indent = '  '.repeat(depth);
    let output = `${indent}[${node.id}] ${node.role ?? ''}`;
    if (node.name) output += ` "${node.name}"`;
    output += '\n';
    for (const child of node.children) output += formatNode(child, depth + 1);
    return output;
  };
  return formatNode(snapshot.root, 0);
}

function paginationOptions(params: PaginationOptions): PaginationOptions | undefined {
  return params.pageSize !== undefined || params.pageIdx !== undefined
    ? { pageSize: params.pageSize, pageIdx: params.pageIdx }
    : undefined;
}
