/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/tools/console.ts,
 * src/tools/network.ts, and src/McpResponse.ts (data collection and text format).
 * Page routing, existing-dialog checks, and transport remain with the host.
 */

import type { ConsoleMessageType, HTTPRequest, Page, ResourceType } from 'puppeteer-core';
import { ConsoleFormatter } from './console-formatter.js';
import type { ConsoleDevToolsModel } from './console-stack.js';
import { getDevToolsData } from './devtools-reader.js';
import { IssueFormatter } from './issue-formatter.js';
import { NetworkFormatter } from './network-formatter.js';
import { saveObservationFile, validateObservationFile, type ObservationFileOptions } from './observation-files.js';
import { ConsoleCollector, ConsoleIssue, NetworkCollector, UncaughtError } from './page-collector.js';
import { formatPagination, type PaginationOptions } from './pagination.js';
import type { ServiceWorkerConsoleCollector } from './service-worker-console.js';

export interface PageDataResult { readonly text: string }
export interface ConsoleListOptions extends PaginationOptions {
  readonly types?: readonly (ConsoleMessageType | 'issue')[];
  readonly includePreservedMessages?: boolean;
  readonly includeStackTraces?: boolean;
  readonly serviceWorkerId?: string;
}
export interface ConsoleDataDependencies {
  readonly serviceWorkers?: Pick<ServiceWorkerConsoleCollector, 'getData' | 'getIdForResource'>;
  readonly devTools?: ConsoleDevToolsModel;
  readonly requestIdResolver?: (cdpRequestId: string) => number | undefined;
  readonly elementIdResolver?: (backendNodeId: number) => string | undefined;
  readonly files?: ObservationFileOptions;
}
export interface NetworkListOptions extends PaginationOptions {
  readonly resourceTypes?: readonly ResourceType[];
  readonly includePreservedRequests?: boolean;
}
export interface NetworkRequestOptions {
  readonly reqid?: number;
  readonly requestFilePath?: string;
  readonly responseFilePath?: string;
}

export async function listConsoleMessages(
  collector: ConsoleCollector,
  options: ConsoleListOptions = {},
  dependencies: ConsoleDataDependencies = {},
): Promise<PageDataResult> {
  const worker = options.serviceWorkerId ? dependencies.serviceWorkers : undefined;
  let messages = options.serviceWorkerId
    ? worker?.getData(options.serviceWorkerId) ?? []
    : collector.getData(options.includePreservedMessages);
  if (options.types?.length) {
    const types = new Set(options.types);
    messages = messages.filter(message => types.has(message instanceof ConsoleIssue ? 'issue'
      : 'type' in message ? message.type() : 'error'));
  }
  let devTools: ConsoleDevToolsModel | undefined;
  if (!options.serviceWorkerId && options.includeStackTraces) {
    if (dependencies.files) collector.devTools.configureFiles(dependencies.files);
    await collector.devTools.ready;
    devTools = dependencies.devTools ?? collector.devTools.model;
  }
  const formatted = (await Promise.all(messages.map(async message => {
    const id = worker && !(message instanceof ConsoleIssue) && !(message instanceof Error)
      ? worker.getIdForResource(message) : collector.getIdForResource(message);
    if ('args' in message || message instanceof UncaughtError) {
      return ConsoleFormatter.from(message, { id, fetchStackTrace: options.includeStackTraces, devTools });
    }
    if (message instanceof ConsoleIssue) {
      const formatter = new IssueFormatter(message, { id });
      return formatter.isValid() ? formatter : null;
    }
    return null;
  }))).filter(message => message !== null);
  const lines = ['## Console messages'];
  if (formatted.length) {
    const grouped = ConsoleFormatter.groupConsecutive(formatted);
    const pagination = formatPagination(grouped, options);
    lines.push(...pagination.info, ...pagination.items.map(message => message.toString()));
    if (pagination.items.some(message => 'stackTrace' in message.toJSON())) {
      lines.push('Note: stack trace line and column numbers use 1-based indexing');
    }
  } else lines.push('<no console messages found>');
  return { text: lines.join('\n') };
}

export async function getConsoleMessage(
  collector: ConsoleCollector,
  msgid: number,
  dependencies: ConsoleDataDependencies = {},
): Promise<PageDataResult> {
  if (!msgid) return { text: '' };
  const message = collector.getById(msgid);
  if ('args' in message || message instanceof UncaughtError) {
    if (dependencies.files) collector.devTools.configureFiles(dependencies.files);
    await collector.devTools.ready;
    const formatter = await ConsoleFormatter.from(message, {
      id: msgid, fetchDetailedData: true, devTools: dependencies.devTools ?? collector.devTools.model,
    });
    return { text: formatter.toStringDetailed() };
  }
  if (message instanceof ConsoleIssue) {
    const formatter = new IssueFormatter(message, { ...dependencies, id: msgid });
    if (!formatter.isValid()) throw new Error(`Can't provide details for the msgid ${msgid}`);
    return { text: formatter.toStringDetailed() };
  }
  return { text: '' };
}

export function resolveCdpRequestId(collector: NetworkCollector, cdpRequestId: string): number | undefined {
  const request = collector.find(request => (request as HTTPRequest & { id: string }).id === cdpRequestId);
  return request ? collector.getIdForResource(request) : undefined;
}

export async function listNetworkRequests(
  page: Page,
  collector: NetworkCollector,
  options: NetworkListOptions = {},
): Promise<PageDataResult> {
  const data = await getDevToolsData(page);
  const selectedId = data.cdpRequestId ? resolveCdpRequestId(collector, data.cdpRequestId) : undefined;
  let requests = collector.getData(options.includePreservedRequests);
  if (options.resourceTypes?.length) {
    const types = new Set(options.resourceTypes);
    requests = requests.filter(request => types.has(request.resourceType()));
  }
  const lines = ['## Network requests'];
  if (requests.length) {
    const formatted = await Promise.all(requests.map(request => NetworkFormatter.from(request, {
      requestId: collector.getIdForResource(request),
      selectedInDevToolsUI: collector.getIdForResource(request) === selectedId,
    })));
    const pagination = formatPagination(formatted, options);
    lines.push(...pagination.info, ...pagination.items.map(request => request.toString()));
  } else lines.push('No requests found.');
  return { text: lines.join('\n') };
}

/** The caller applies the page-scoped existing-dialog check before this helper. */
export async function getNetworkRequest(
  page: Page,
  collector: NetworkCollector,
  options: NetworkRequestOptions = {},
  files?: ObservationFileOptions,
): Promise<PageDataResult> {
  if (options.requestFilePath) await validateObservationFile(options.requestFilePath, '.network-request', files!);
  if (options.responseFilePath) await validateObservationFile(options.responseFilePath, '.network-response', files!);
  let reqid = options.reqid;
  if (!reqid) {
    const data = await getDevToolsData(page);
    reqid = data.cdpRequestId ? resolveCdpRequestId(collector, data.cdpRequestId) : undefined;
    if (!reqid) return { text: 'Nothing is currently selected in the DevTools Network panel.' };
  }
  const request: HTTPRequest = collector.getById(reqid);
  const formatter = await NetworkFormatter.from(request, {
    requestId: reqid, requestIdResolver: request => collector.getIdForResource(request), fetchData: true,
    requestFilePath: options.requestFilePath, responseFilePath: options.responseFilePath,
    saveFile: files ? (data, filename, extension) => saveObservationFile(data, filename, extension, files) : undefined,
  });
  return { text: formatter.toStringDetailed() };
}
