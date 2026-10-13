/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 McpContext/McpPage. Stable page IDs
 * and named browser contexts share the host registry; SDK index access stays local.
 */

import type { Browser, BrowserContext, CDPSession, Dialog, Frame, HTTPRequest, Page, Target } from 'puppeteer-core';
import {
  ConsoleCollector,
  type ConsoleObservation,
  NetworkCollector,
} from './page-collector.js';
import { ServiceWorkerConsoleCollector } from './service-worker-console.js';
import { isAllowedUrl } from './url.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
export const CLOSE_PAGE_ERROR =
  'The last open page cannot be closed. It is fine to keep it open.';

let nextPageId = 1;

export interface RegisteredPage {
  readonly pageId: number;
  readonly page: Page;
  readonly navigationSequence: number;
  readonly isolatedContextName?: string;
}

export interface PageIdentity {
  readonly pageId: number;
  readonly pageIndex: number;
  readonly url: string;
}

export interface PageChangeSet {
  readonly opened: readonly PageIdentity[];
  readonly closed: readonly PageIdentity[];
}

interface PageRecord {
  readonly pageId: number;
  readonly page: Page;
  navigationSequence: number;
  closed: boolean;
  readonly isolatedContextName?: string;
  dialog?: Dialog;
  readonly onDialog: (dialog: Dialog) => void;
  readonly onFrameNavigated: (frame: Frame) => void;
  readonly onFrameDetached: (frame: Frame) => void;
  readonly onClose: () => void;
  readonly consoleCollector: ConsoleCollector;
  readonly networkCollector: NetworkCollector;
  releaseMouse?: () => void;
}

export interface PageRegistryEvents {
  selectedPageChanged(previousPageId: number | undefined, pageId: number | undefined): void;
  mainFrameNavigated(pageId: number): void;
  pageRemoved?(pageId: number): void;
  frameChanged?(page: RegisteredPage, frame: Frame): void;
  screenChanged?(page: RegisteredPage | undefined): void;
  observeMouse?(page: Page, current: () => RegisteredPage): () => void;
}

export class PageRegistry {
  readonly #browser: Browser;
  readonly #events: PageRegistryEvents;
  readonly #serviceWorkerConsoleCollector: ServiceWorkerConsoleCollector;
  readonly #records = new Map<Page, PageRecord>();
  readonly #opened = new Map<number, PageIdentity>();
  readonly #closed = new Map<number, PageIdentity>();
  readonly #isolatedContexts = new Map<string, BrowserContext>();
  #nextIsolatedContextId = 1;
  #selectedPage: PageRecord | undefined;
  #selectedPageFallback: { wasClosed: boolean } | undefined;
  #initialized = false;
  #disposed = false;

  private constructor(browser: Browser, events: PageRegistryEvents) {
    this.#browser = browser;
    this.#events = events;
    this.#serviceWorkerConsoleCollector = new ServiceWorkerConsoleCollector(browser);
  }

  static async create(browser: Browser, events: PageRegistryEvents): Promise<PageRegistry> {
    const registry = new PageRegistry(browser, events);
    await registry.#initialize();
    return registry;
  }

  static resetPageIdsForTesting(): void {
    nextPageId = 1;
  }

  pages(): readonly RegisteredPage[] {
    this.#assertActive();
    return [...this.#records.values()].map(toRegisteredPage);
  }

  async refresh(): Promise<readonly RegisteredPage[]> {
    this.#assertActive();
    const pages = (await this.#browser.pages()).filter(isAutomatablePage);
    this.#selectedPageFallback = undefined;
    const currentPages = new Set(pages);

    for (const page of pages) this.#register(page, this.#initialized);
    for (const record of [...this.#records.values()]) {
      // Target enumeration can omit a live Page while secondary CDP sessions detach.
      // Keep its existing owner until Page.close or a URL policy change ends ownership.
      if (!isClosedPage(record.page) && (currentPages.has(record.page) || isAutomatablePage(record.page))) continue;
      this.#remove(record);
    }

    this.#selectFallback();
    return this.pages();
  }

  selectedPage(): RegisteredPage {
    this.#assertActive();
    const record = this.#selectedPage;
    if (!record) throw new Error('No page selected');
    if (record.closed || isClosedPage(record.page)) {
      throw new Error('The selected page has been closed. Call list_pages to see open pages.');
    }
    return toRegisteredPage(record);
  }

  selectedPageIndex(): number {
    const selected = this.selectedPage();
    return [...this.#records.values()].findIndex((record) => record.pageId === selected.pageId);
  }

  pageByIndex(pageIndex: number): RegisteredPage {
    this.#assertActive();
    const record = [...this.#records.values()][pageIndex];
    if (!record) throw new Error('No page found');
    return toRegisteredPage(record);
  }

  pageById(pageId: number): RegisteredPage | undefined {
    this.#assertActive();
    const record = this.#recordById(pageId);
    return record ? toRegisteredPage(record) : undefined;
  }

  selectByIndex(pageIndex: number): RegisteredPage {
    const record = this.#recordById(this.pageByIndex(pageIndex).pageId)!;
    this.#select(record.pageId);
    return toRegisteredPage(record);
  }

  selectById(pageId: number): RegisteredPage {
    const record = this.#requireRecord(pageId);
    this.#select(record.pageId);
    return toRegisteredPage(record);
  }

  async newPage(options: { background?: boolean; isolatedContext?: string } = {}): Promise<RegisteredPage> {
    this.#assertActive();
    let page: Page;
    if (options.isolatedContext !== undefined) {
      let context = this.#isolatedContexts.get(options.isolatedContext);
      if (!context) {
        context = await this.#browser.createBrowserContext();
        this.#isolatedContexts.set(options.isolatedContext, context);
      }
      page = await context.newPage({ background: options.background });
    } else {
      page = await this.#browser.newPage({ background: options.background });
    }
    const record = this.#register(page, true);
    if (!record) throw new Error('No page found');
    await record.consoleCollector.devTools.ready;
    await this.refresh();
    this.#select(record.pageId);
    return toRegisteredPage(record);
  }

  closeByIndex(pageIndex: number): Promise<void> {
    return this.closeById(this.pageByIndex(pageIndex).pageId);
  }

  async closeById(pageId: number): Promise<void> {
    this.#assertActive();
    if (this.#records.size === 1) throw new Error(CLOSE_PAGE_ERROR);
    const record = this.#requireRecord(pageId);
    await record.page.close({ runBeforeUnload: false });
    this.#remove(record, true);
  }

  getDialog(pageId?: number): Dialog | undefined {
    return this.#recordById(pageId ?? this.#selectedPage?.pageId)?.dialog;
  }

  clearDialog(pageId?: number): void {
    const record = this.#recordById(pageId ?? this.#selectedPage?.pageId);
    if (record) record.dialog = undefined;
  }

  getConsoleCollector(pageId?: number): ConsoleCollector { return this.#requireRecord(pageId).consoleCollector; }
  getNetworkCollector(pageId?: number): NetworkCollector { return this.#requireRecord(pageId).networkCollector; }
  getServiceWorkerConsoleCollector(): ServiceWorkerConsoleCollector {
    this.#assertActive();
    return this.#serviceWorkerConsoleCollector;
  }

  getConsoleData(includePreservedMessages = false, pageId?: number): readonly ConsoleObservation[] {
    return this.#requireRecord(pageId).consoleCollector.getData(includePreservedMessages);
  }

  getConsoleMessageById(messageId: number, pageId?: number): ConsoleObservation {
    return this.#requireRecord(pageId).consoleCollector.getById(messageId);
  }

  getConsoleMessageId(message: ConsoleObservation, pageId?: number): number {
    return this.#requireRecord(pageId).consoleCollector.getIdForResource(message);
  }

  getNetworkRequests(includePreservedRequests = false, pageId?: number): readonly HTTPRequest[] {
    return this.#requireRecord(pageId).networkCollector.getData(includePreservedRequests);
  }

  getNetworkRequestById(requestId: number, pageId?: number): HTTPRequest {
    return this.#requireRecord(pageId).networkCollector.getById(requestId);
  }

  getNetworkRequestId(request: HTTPRequest, pageId?: number): number {
    return this.#requireRecord(pageId).networkCollector.getIdForResource(request);
  }

  consumeChanges(): PageChangeSet {
    this.#assertActive();
    const opened = [...this.#opened].map(([pageId, identity]) => {
      const current = this.#recordById(pageId);
      return current ? this.#identity(current) : identity;
    });
    const result: PageChangeSet = {
      opened: Object.freeze(opened),
      closed: Object.freeze([...this.#closed.values()]),
    };
    this.#opened.clear();
    this.#closed.clear();
    return result;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#browser.off('targetcreated', this.#onTargetCreated);
    this.#browser.off('targetdestroyed', this.#onTargetDestroyed);
    this.#serviceWorkerConsoleCollector.dispose();
    for (const record of this.#records.values()) this.#detach(record);
    this.#records.clear();
    this.#opened.clear();
    this.#closed.clear();
    this.#isolatedContexts.clear();
    this.#selectedPage = undefined;
    this.#selectedPageFallback = undefined;
    this.#events.screenChanged?.(undefined);
  }

  async #initialize(): Promise<void> {
    this.#browser.on('targetcreated', this.#onTargetCreated);
    this.#browser.on('targetdestroyed', this.#onTargetDestroyed);
    try {
      await this.#serviceWorkerConsoleCollector.init();
      for (const page of await this.#browser.pages()) this.#register(page, false);
      await Promise.all([...this.#records.values()].map(record => record.consoleCollector.devTools.ready));
      this.#selectFallback();
      for (const record of this.#records.values()) {
        this.#opened.set(record.pageId, this.#identity(record));
      }
      this.#initialized = true;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  #onTargetCreated = async (target: Target): Promise<void> => {
    try {
      const page = await target.page();
      if (page && !this.#disposed) {
        const record = this.#register(page, this.#initialized);
        if (!record) return;
        await record.consoleCollector.devTools.ready;
        if (!this.#disposed && this.#selectedPage === undefined && this.#records.get(page) === record) {
          this.#select(record.pageId);
        }
      }
    } catch {
      // Target creation can race target destruction; the next refresh is authoritative.
    }
  };

  #onTargetDestroyed = (target: Target): void => {
    const record = [...this.#records.values()].find((entry) => entry.page.target() === target);
    // A secondary-session detach does not close the Page's primary session.
    // On real tab close, that session can detach before Page.isClosed() updates.
    if (record && isClosedPage(record.page)) this.#remove(record, true);
  };

  #register(page: Page, recordChange: boolean): PageRecord | undefined {
    if (isClosedPage(page) || !isAutomatablePage(page)) return undefined;
    const existing = this.#records.get(page);
    if (existing) return existing;

    const record = {} as PageRecord;
    Object.assign(record, {
      pageId: nextPageId++,
      page,
      navigationSequence: 0,
      closed: false,
      isolatedContextName: this.#getBrowserContextNames().get(page.browserContext()),
      onDialog: (dialog: Dialog) => {
        record.dialog = dialog;
      },
      onFrameNavigated: (frame: Frame) => {
        this.#events.frameChanged?.(toRegisteredPage(record), frame);
        if (frame !== page.mainFrame()) return;
        record.navigationSequence += 1;
        this.#events.mainFrameNavigated(record.pageId);
      },
      onFrameDetached: (frame: Frame) => this.#events.frameChanged?.(toRegisteredPage(record), frame),
      onClose: () => this.#remove(record, true),
      consoleCollector: new ConsoleCollector(page),
      networkCollector: new NetworkCollector(page),
    } satisfies PageRecord);

    record.releaseMouse = this.#events.observeMouse?.(page, () => toRegisteredPage(record));
    this.#records.set(page, record);
    page.on('dialog', record.onDialog);
    page.on('framenavigated', record.onFrameNavigated);
    page.on('framedetached', record.onFrameDetached);
    page.on('close', record.onClose);
    updateTimeouts(page);
    void page.emulateFocusedPage(true).catch(() => undefined);

    if (recordChange) this.#opened.set(record.pageId, this.#identity(record));
    return record;
  }

  #remove(record: PageRecord, wasClosed = isClosedPage(record.page)): void {
    if (this.#records.get(record.page) !== record) return;
    record.closed = wasClosed;
    const identity = this.#identity(record);
    if (this.#opened.has(record.pageId)) this.#opened.set(record.pageId, identity);
    this.#detach(record);
    this.#records.delete(record.page);
    this.#events.pageRemoved?.(record.pageId);
    if (this.#initialized) this.#closed.set(record.pageId, identity);

    if (this.#selectedPage === record && wasClosed) this.#events.screenChanged?.(undefined);
  }

  #detach(record: PageRecord): void {
    record.page.off('dialog', record.onDialog);
    record.page.off('framenavigated', record.onFrameNavigated);
    record.page.off('framedetached', record.onFrameDetached);
    record.page.off('close', record.onClose);
    record.consoleCollector.dispose();
    record.networkCollector.dispose();
    record.dialog = undefined;
    record.releaseMouse?.();
  }

  consumeSelectedPageFallback(): { wasClosed: boolean } | undefined {
    const fallback = this.#selectedPageFallback;
    this.#selectedPageFallback = undefined;
    return fallback;
  }

  #selectFallback(): void {
    // As in the fixed source, enumeration alone does not replace a live selection.
    if (this.#selectedPage && !this.#selectedPage.closed && !isClosedPage(this.#selectedPage.page)) return;
    const first = this.#records.values().next().value as PageRecord | undefined;
    if (!first) return;
    const previous = this.#selectedPage;
    this.#select(first.pageId);
    if (previous) this.#selectedPageFallback = { wasClosed: previous.closed || isClosedPage(previous.page) };
  }

  #select(pageId: number): void {
    const record = this.#recordById(pageId);
    if (!record) throw new Error('No page found');
    this.#selectedPageFallback = undefined;
    if (this.#selectedPage === record) return;
    const previousPageId = this.#selectedPage?.pageId;
    this.#selectedPage = record;
    updateTimeouts(record.page);
    this.#events.selectedPageChanged(previousPageId, pageId);
    this.#events.screenChanged?.(toRegisteredPage(record));
  }

  #recordById(pageId: number | undefined): PageRecord | undefined {
    if (pageId === undefined) return undefined;
    return [...this.#records.values()].find((record) => record.pageId === pageId);
  }

  #requireRecord(pageId?: number): PageRecord {
    this.#assertActive();
    const record = pageId === undefined ? this.#selectedPage : this.#recordById(pageId);
    if (!record) throw new Error(pageId === undefined ? 'No page selected' : 'No page found');
    return record;
  }

  #getBrowserContextNames(): Map<BrowserContext, string> {
    const names = new Map<BrowserContext, string>();
    for (const [name, context] of this.#isolatedContexts) names.set(context, name);
    const defaultContext = this.#browser.defaultBrowserContext();
    for (const context of this.#browser.browserContexts()) {
      if (context === defaultContext || context.closed || names.has(context)) continue;
      const name = `isolated-context-${this.#nextIsolatedContextId++}`;
      this.#isolatedContexts.set(name, context);
      names.set(context, name);
    }
    return names;
  }

  #identity(record: PageRecord): PageIdentity {
    return {
      pageId: record.pageId,
      pageIndex: [...this.#records.values()].indexOf(record),
      url: record.page.url(),
    };
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Browser page registry has been disposed');
  }
}

function isClosedPage(page: Page): boolean {
  const primary = (page as Page & { _client?: () => CDPSession })._client?.();
  return page.isClosed() || primary?.detached === true;
}

function isAutomatablePage(page: Page): boolean {
  const url = page.url();
  return !url.startsWith('devtools://') && isAllowedUrl(url);
}

function updateTimeouts(page: Page): void {
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);
}

function toRegisteredPage(record: PageRecord): RegisteredPage {
  return {
    pageId: record.pageId,
    page: record.page,
    navigationSequence: record.navigationSequence,
    isolatedContextName: record.isolatedContextName,
  };
}
