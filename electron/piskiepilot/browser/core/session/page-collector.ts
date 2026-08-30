/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.7.0 src/PageCollector.ts. DevTools
 * issue aggregation was omitted; Piskie retains the console and page-error
 * observations provided by its previous browser runtime.
 */

import type {
  ConsoleMessage,
  Frame,
  Handler,
  HTTPRequest,
  Page,
  PageEvents,
} from 'puppeteer-core';

export const stableIdSymbol = Symbol('stableIdSymbol');

export type WithStableId<T> = T & { [stableIdSymbol]?: number };
export type ConsoleObservation = ConsoleMessage | Error;

interface CollectedPageEvents {
  console: ConsoleMessage;
  pageerror: Error | unknown;
  request: HTTPRequest;
  framenavigated: Frame;
}

type ListenerMap = {
  [K in keyof CollectedPageEvents]?: (event: CollectedPageEvents[K]) => void;
};

export class PageCollector<T> {
  protected readonly page: Page;
  protected readonly maxNavigationsSaved = 3;
  protected readonly storage: Array<Array<WithStableId<T>>> = [[]];
  readonly #listeners: ListenerMap;

  constructor(
    page: Page,
    listeners: (collect: (item: T) => void) => ListenerMap,
    maxResourcesPerNavigation?: number,
  ) {
    this.page = page;
    const nextId = createIdGenerator();
    const listenerMap = listeners((value) => {
      const item = value as WithStableId<T>;
      item[stableIdSymbol] = nextId();
      this.storage[0].push(item);
      if (
        maxResourcesPerNavigation !== undefined
        && this.storage[0].length > maxResourcesPerNavigation
      ) {
        this.storage[0].splice(
          0,
          this.storage[0].length - maxResourcesPerNavigation,
        );
      }
    });

    listenerMap.framenavigated = (frame: Frame) => {
      if (frame === this.page.mainFrame()) this.splitAfterNavigation();
    };

    for (const [name, listener] of Object.entries(listenerMap)) {
      this.page.on(name as keyof PageEvents, listener as Handler<unknown>);
    }
    this.#listeners = listenerMap;
  }

  dispose(): void {
    for (const [name, listener] of Object.entries(this.#listeners)) {
      this.page.off(name as keyof PageEvents, listener as Handler<unknown>);
    }
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

  getIdForResource(resource: T): number {
    return (resource as WithStableId<T>)[stableIdSymbol] ?? -1;
  }

  getById(stableId: number): T {
    const item = this.find((candidate) => candidate[stableIdSymbol] === stableId);
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
  constructor(page: Page) {
    super(page, (collect) => ({
      console: (event) => collect(event),
      pageerror: (event) => {
        if (event instanceof Error) {
          collect(event);
          return;
        }
        const error = new Error(String(event));
        error.stack = undefined;
        collect(error);
      },
    }));
  }
}

export class NetworkCollector extends PageCollector<HTTPRequest> {
  static readonly MAX_REQUESTS_PER_NAVIGATION = 1_000;

  constructor(page: Page, maxRequestsPerNavigation = NetworkCollector.MAX_REQUESTS_PER_NAVIGATION) {
    super(page, (collect) => ({ request: (request) => collect(request) }), maxRequestsPerNavigation);
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

    if (lastRequestIndex !== -1) {
      const currentNavigation = requests.splice(lastRequestIndex);
      this.storage.unshift(currentNavigation);
    } else {
      this.storage.unshift([]);
    }
    this.storage.splice(this.maxNavigationsSaved);
  }
}

function createIdGenerator(): () => number {
  let nextId = 1;
  return () => {
    if (nextId === Number.MAX_SAFE_INTEGER) nextId = 0;
    return nextId++;
  };
}
