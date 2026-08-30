/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.7.0 McpContext/McpPage. Piskie keeps its
 * existing page-index API and page-change text while using process-wide IDs.
 */

import type { Browser, Dialog, Frame, HTTPRequest, Page, Target } from 'puppeteer-core';
import {
  ConsoleCollector,
  type ConsoleObservation,
  NetworkCollector,
} from './page-collector.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
export const CLOSE_PAGE_ERROR =
  'The last open page cannot be closed. It is fine to keep it open.';

let nextPageId = 1;

export interface RegisteredPage {
  readonly pageId: number;
  readonly page: Page;
  readonly navigationSequence: number;
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
  dialog?: Dialog;
  readonly onDialog: (dialog: Dialog) => void;
  readonly onFrameNavigated: (frame: Frame) => void;
  readonly onClose: () => void;
  readonly consoleCollector: ConsoleCollector;
  readonly networkCollector: NetworkCollector;
}

export interface PageRegistryEvents {
  selectedPageChanged(previousPageId: number | undefined, pageId: number | undefined): void;
  mainFrameNavigated(pageId: number): void;
}

export class PageRegistry {
  readonly #browser: Browser;
  readonly #events: PageRegistryEvents;
  readonly #records = new Map<Page, PageRecord>();
  readonly #opened = new Map<number, PageIdentity>();
  readonly #closed = new Map<number, PageIdentity>();
  #selectedPageId: number | undefined;
  #initialized = false;
  #disposed = false;

  private constructor(browser: Browser, events: PageRegistryEvents) {
    this.#browser = browser;
    this.#events = events;
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
    const currentPages = new Set(pages);

    for (const page of pages) this.#register(page, this.#initialized);
    for (const record of [...this.#records.values()]) {
      if (currentPages.has(record.page)) continue;
      // This is the same selected-page guard used by McpContext 1.7.0: a live
      // selected target is not silently replaced because of a transient list.
      if (record.pageId === this.#selectedPageId && !record.page.isClosed()) continue;
      this.#remove(record);
    }

    this.#selectFallback();
    return this.pages();
  }

  selectedPage(): RegisteredPage {
    this.#assertActive();
    const record = this.#recordById(this.#selectedPageId);
    if (!record) throw new Error('No page selected');
    if (record.page.isClosed()) {
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

  async newPage(): Promise<RegisteredPage> {
    this.#assertActive();
    const page = await this.#browser.newPage();
    const record = this.#register(page, true);
    this.#select(record.pageId);
    return toRegisteredPage(record);
  }

  async closeByIndex(pageIndex: number): Promise<void> {
    this.#assertActive();
    if (this.#records.size === 1) throw new Error(CLOSE_PAGE_ERROR);
    const record = this.#recordById(this.pageByIndex(pageIndex).pageId)!;
    await record.page.close({ runBeforeUnload: false });
    this.#remove(record);
  }

  getDialog(pageId?: number): Dialog | undefined {
    return this.#recordById(pageId ?? this.#selectedPageId)?.dialog;
  }

  clearDialog(pageId?: number): void {
    const record = this.#recordById(pageId ?? this.#selectedPageId);
    if (record) record.dialog = undefined;
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
    for (const record of this.#records.values()) this.#detach(record);
    this.#records.clear();
    this.#opened.clear();
    this.#closed.clear();
    this.#selectedPageId = undefined;
  }

  async #initialize(): Promise<void> {
    this.#browser.on('targetcreated', this.#onTargetCreated);
    this.#browser.on('targetdestroyed', this.#onTargetDestroyed);
    try {
      for (const page of await this.#browser.pages()) {
        if (isAutomatablePage(page)) this.#register(page, false);
      }
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
      if (page && !this.#disposed && isAutomatablePage(page)) {
        this.#register(page, this.#initialized);
      }
    } catch {
      // Target creation can race target destruction; the next refresh is authoritative.
    }
  };

  #onTargetDestroyed = (target: Target): void => {
    const record = [...this.#records.values()].find((entry) => entry.page.target() === target);
    if (record) this.#remove(record);
  };

  #register(page: Page, recordChange: boolean): PageRecord {
    const existing = this.#records.get(page);
    if (existing) return existing;

    const record = {} as PageRecord;
    Object.assign(record, {
      pageId: nextPageId++,
      page,
      navigationSequence: 0,
      onDialog: (dialog: Dialog) => {
        record.dialog = dialog;
      },
      onFrameNavigated: (frame: Frame) => {
        if (frame !== page.mainFrame()) return;
        record.navigationSequence += 1;
        this.#events.mainFrameNavigated(record.pageId);
      },
      onClose: () => this.#remove(record),
      consoleCollector: new ConsoleCollector(page),
      networkCollector: new NetworkCollector(page),
    } satisfies PageRecord);

    this.#records.set(page, record);
    page.on('dialog', record.onDialog);
    page.on('framenavigated', record.onFrameNavigated);
    page.on('close', record.onClose);
    void page.emulateFocusedPage(true).catch(() => undefined);

    if (recordChange) this.#opened.set(record.pageId, this.#identity(record));
    if (this.#selectedPageId === undefined) this.#select(record.pageId);
    return record;
  }

  #remove(record: PageRecord): void {
    if (!this.#records.has(record.page)) return;
    const identity = this.#identity(record);
    if (this.#opened.has(record.pageId)) this.#opened.set(record.pageId, identity);
    this.#detach(record);
    this.#records.delete(record.page);
    if (this.#initialized) this.#closed.set(record.pageId, identity);

    if (this.#selectedPageId === record.pageId) {
      const previousPageId = this.#selectedPageId;
      this.#selectedPageId = undefined;
      this.#selectFallback(previousPageId);
    }
  }

  #detach(record: PageRecord): void {
    record.page.off('dialog', record.onDialog);
    record.page.off('framenavigated', record.onFrameNavigated);
    record.page.off('close', record.onClose);
    record.consoleCollector.dispose();
    record.networkCollector.dispose();
    record.dialog = undefined;
  }

  #selectFallback(previousPageId?: number): void {
    if (this.#selectedPageId !== undefined) return;
    const first = this.#records.values().next().value as PageRecord | undefined;
    if (first) {
      this.#selectedPageId = first.pageId;
      updateTimeouts(first.page);
      this.#events.selectedPageChanged(previousPageId, first.pageId);
    } else if (previousPageId !== undefined) {
      this.#events.selectedPageChanged(previousPageId, undefined);
    }
  }

  #select(pageId: number): void {
    if (this.#selectedPageId === pageId) return;
    const record = this.#recordById(pageId);
    if (!record) throw new Error('No page found');
    const previousPageId = this.#selectedPageId;
    this.#selectedPageId = pageId;
    updateTimeouts(record.page);
    this.#events.selectedPageChanged(previousPageId, pageId);
  }

  #recordById(pageId: number | undefined): PageRecord | undefined {
    if (pageId === undefined) return undefined;
    return [...this.#records.values()].find((record) => record.pageId === pageId);
  }

  #requireRecord(pageId?: number): PageRecord {
    const record = this.#recordById(pageId ?? this.#selectedPageId);
    if (!record) throw new Error('No page selected');
    return record;
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

function isAutomatablePage(page: Page): boolean {
  return !page.url().startsWith('devtools://');
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
  };
}
