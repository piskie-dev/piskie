/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/collectors/PageCollector.ts.
 * Page ownership stays in the existing registry. DevTools observations use the
 * fixed frontend subset and a per-page observation session.
 */

import type { CDPSession, ConsoleMessage, Frame, Handler, HTTPRequest, Issue, Page, PageEvents, Protocol } from 'puppeteer-core';
import { FrameEvent } from 'puppeteer-core/internal/api/Frame.js';
import {
  AggregatedIssue as ConsoleIssue,
  createIssuesFromProtocolIssue,
  initializeConsoleFrontend,
  isIssueCodeSupported,
  IssueAggregator,
  IssueAggregatorEvents,
  IssueProvider,
  IssuesManagerEvents,
} from '../../third_party/devtools-frontend-61277fe/observation.js';
import { PageConsoleDevTools, loadConsoleResource } from './console-devtools.js';

export { ConsoleIssue };
export const stableIdSymbol = Symbol('stableIdSymbol');
export type WithStableId<T> = T & { [stableIdSymbol]?: number };
export type ConsoleObservation = ConsoleMessage | Error | UncaughtError | ConsoleIssue;

export class UncaughtError {
  constructor(readonly details: Protocol.Runtime.ExceptionDetails, readonly targetId: string) {}
}

interface CollectedPageEvents {
  console: ConsoleMessage;
  pageerror: Error | unknown;
  request: HTTPRequest;
  framenavigated: Frame;
  issue: Issue;
}
export type ListenerMap = {
  [K in keyof CollectedPageEvents]?: (event: CollectedPageEvents[K]) => void;
};

export class PageCollector<T> {
  protected readonly page: Page;
  protected readonly maxNavigationsSaved = 3;
  protected readonly storage: Array<Array<WithStableId<T>>> = [[]];
  readonly #listeners: ListenerMap;
  #pendingSameDocumentNavigation = false;
  #frameTarget?: Frame;

  constructor(page: Page, listeners: (collect: (item: T) => void) => ListenerMap, maxResourcesPerNavigation?: number) {
    this.page = page;
    this.#attachFrameListener();
    const nextId = createIdGenerator();
    const listenerMap = listeners(value => {
      const item = value as WithStableId<T>;
      item[stableIdSymbol] = nextId();
      this.storage[0].push(item);
      if (maxResourcesPerNavigation !== undefined && this.storage[0].length > maxResourcesPerNavigation) {
        this.storage[0].splice(0, this.storage[0].length - maxResourcesPerNavigation);
      }
    });
    listenerMap.framenavigated = frame => {
      if (frame !== this.page.mainFrame()) return;
      this.#attachFrameListener();
      if (this.#pendingSameDocumentNavigation) {
        this.#pendingSameDocumentNavigation = false;
        return;
      }
      this.splitAfterNavigation();
    };
    for (const [name, listener] of Object.entries(listenerMap)) {
      this.page.on(name as keyof PageEvents, listener as Handler<unknown>);
    }
    this.#listeners = listenerMap;
  }

  dispose(): void {
    this.#detachFrameListener();
    for (const [name, listener] of Object.entries(this.#listeners)) {
      this.page.off(name as keyof PageEvents, listener as Handler<unknown>);
    }
  }

  #onSameDocumentNavigation = (): void => { this.#pendingSameDocumentNavigation = true; };

  #attachFrameListener(): void {
    this.#detachFrameListener();
    this.#frameTarget = this.page.mainFrame();
    this.#frameTarget.on(FrameEvent.FrameNavigatedWithinDocument, this.#onSameDocumentNavigation);
  }

  #detachFrameListener(): void {
    this.#frameTarget?.off(FrameEvent.FrameNavigatedWithinDocument, this.#onSameDocumentNavigation);
    this.#frameTarget = undefined;
  }

  protected splitAfterNavigation(): void {
    this.storage.unshift([]);
    this.storage.splice(this.maxNavigationsSaved);
  }

  getData(includePreservedData = false): readonly T[] {
    if (!includePreservedData) return this.storage[0];
    const data: T[] = [];
    for (let index = this.maxNavigationsSaved; index >= 0; index -= 1) {
      if (this.storage[index]) data.push(...this.storage[index]);
    }
    return data;
  }

  getIdForResource(resource: T): number { return (resource as WithStableId<T>)[stableIdSymbol] ?? -1; }

  getById(stableId: number): T {
    const item = this.find(candidate => candidate[stableIdSymbol] === stableId);
    if (!item) throw new Error('Request not found for selected page');
    return item;
  }

  find(filter: (item: WithStableId<T>) => boolean): WithStableId<T> | undefined {
    for (const navigation of this.storage) {
      const item = navigation.find(filter);
      if (item) return item;
    }
    return undefined;
  }
}

export class ConsoleCollector extends PageCollector<ConsoleObservation> {
  static readonly MAX_MESSAGES_PER_NAVIGATION = 10_000;
  readonly devTools: PageConsoleDevTools;
  readonly #session?: CDPSession;
  readonly #collect: (item: ConsoleObservation) => void;
  readonly #seenKeys = new Set<string>();
  readonly #seenIssues = new Set<ConsoleIssue>();
  #issueProvider!: IssueProvider;
  #issueAggregator!: IssueAggregator;

  constructor(page: Page, maxMessagesPerNavigation = ConsoleCollector.MAX_MESSAGES_PER_NAVIGATION) {
    const session = (page as Page & { _client?: () => CDPSession })._client?.();
    let collectObservation!: (item: ConsoleObservation) => void;
    super(page, collect => {
      collectObservation = collect;
      return {
        console: event => collect(event),
        issue: event => this.#onIssue(event),
        ...(!session ? { pageerror: (event: unknown) => {
          const error = event instanceof Error ? event : new Error(String(event));
          if (!(event instanceof Error)) error.stack = undefined;
          collect(error);
        } } : {}),
      };
    }, maxMessagesPerNavigation);
    this.#collect = collectObservation;
    this.#session = session;
    initializeConsoleFrontend(loadConsoleResource);
    this.#resetIssueAggregator();
    this.#session?.on('Runtime.exceptionThrown', this.#onException);
    this.devTools = new PageConsoleDevTools(page);
  }

  #resetIssueAggregator(): void {
    this.#issueAggregator?.removeEventListener(IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED, this.#onAggregatedIssue);
    this.#issueProvider = new IssueProvider();
    this.#issueAggregator = new IssueAggregator(this.#issueProvider);
    this.#issueAggregator.addEventListener(IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED, this.#onAggregatedIssue);
  }

  #onAggregatedIssue = (event: { data: ConsoleIssue }): void => {
    if (this.#seenIssues.has(event.data)) return;
    this.#seenIssues.add(event.data);
    this.#collect(event.data);
  };

  #onException = (event: Protocol.Runtime.ExceptionThrownEvent): void => {
    const target = (this.#session as CDPSession & { target(): { _targetId: string } }).target();
    this.#collect(new UncaughtError(event.exceptionDetails, target._targetId));
  };

  #onIssue(issue: Issue): void {
    try {
      if (!isIssueCodeSupported(issue.code)) return;
      const mapped = createIssuesFromProtocolIssue(null, issue)[0];
      if (!mapped || this.#seenKeys.has(mapped.primaryKey())) return;
      this.#seenKeys.add(mapped.primaryKey());
      this.#issueProvider.dispatchEventToListeners(IssuesManagerEvents.ISSUE_ADDED, { issue: mapped, issuesModel: null });
    } catch {
      // As upstream, an unsupported or unmappable protocol issue is skipped.
    }
  }

  protected override splitAfterNavigation(): void {
    super.splitAfterNavigation();
    this.#seenKeys.clear();
    this.#seenIssues.clear();
    this.#resetIssueAggregator();
  }

  override dispose(): void {
    super.dispose();
    this.#session?.off('Runtime.exceptionThrown', this.#onException);
    this.#issueAggregator.removeEventListener(IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED, this.#onAggregatedIssue);
    this.#seenKeys.clear();
    this.#seenIssues.clear();
    this.devTools.dispose();
  }
}

export class NetworkCollector extends PageCollector<HTTPRequest> {
  static readonly MAX_REQUESTS_PER_NAVIGATION = 1_000;

  constructor(page: Page, maxRequestsPerNavigation = NetworkCollector.MAX_REQUESTS_PER_NAVIGATION) {
    super(page, collect => ({ request: request => collect(request) }), maxRequestsPerNavigation);
  }

  protected override splitAfterNavigation(): void {
    const requests = this.storage[0];
    let lastRequestIndex = -1;
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const request = requests[index];
      if (request.frame() === this.page.mainFrame() && request.isNavigationRequest()) {
        lastRequestIndex = index;
        break;
      }
    }
    this.storage.unshift(lastRequestIndex !== -1 ? requests.splice(lastRequestIndex) : []);
    this.storage.splice(this.maxNavigationsSaved);
  }
}

export function createIdGenerator(): () => number {
  let nextId = 1;
  return () => {
    if (nextId === Number.MAX_SAFE_INTEGER) nextId = 0;
    return nextId++;
  };
}
