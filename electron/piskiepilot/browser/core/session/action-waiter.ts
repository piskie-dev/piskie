/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.7.0 src/WaitForHelper.ts: MCP logging
 * and response types were replaced with a transport-free action receipt.
 */

import type { CDPSession, Dialog, JSHandle, Page, Protocol } from 'puppeteer-core';

const DEFAULT_NAVIGATION_TIMEOUT_MS = 3_000;
const EXPECT_NAVIGATION_WITHIN_MS = 100;
const STABLE_DOM_TIMEOUT_MS = 3_000;
const STABLE_DOM_FOR_MS = 100;

export interface DialogObservation {
  readonly type: string;
  readonly message: string;
  readonly defaultValue: string;
  readonly handled: boolean;
}

export interface ActionReceipt {
  readonly navigated: boolean;
  readonly navigatedToUrl?: string;
  readonly domSettled: boolean;
  readonly dialog?: DialogObservation;
  readonly openedPageIds: readonly number[];
  readonly closedPageIds: readonly number[];
}

export type DialogAction = 'accept' | 'dismiss' | string;

export interface ActionWaitOptions {
  readonly navigationTimeoutMs?: number;
  readonly handleDialog?: DialogAction | Readonly<Record<string, DialogAction>>;
}

type ActionPage = Page & { _client(): CDPSession };

interface StableDomObserver {
  readonly resolver: {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  };
  readonly observer: MutationObserver;
}

/** One-use adaptation of chrome-devtools-mcp 1.7.0 WaitForHelper. */
export class ActionWaiter {
  readonly #abortController = new AbortController();
  readonly #page: ActionPage;
  readonly #initialUrl: string;
  #dialog: DialogObservation | undefined;
  #dialogDetected = false;
  #dialogHandled = false;
  #navigationObserved = false;

  constructor(page: Page) {
    this.#page = page as ActionPage;
    this.#initialUrl = page.url();
  }

  async run(action: () => Promise<unknown>, options: ActionWaitOptions = {}): Promise<ActionReceipt> {
    if (this.#abortController.signal.aborted) {
      throw new Error("Can't re-use an ActionWaiter");
    }

    const dialogHandler = (dialog: Dialog): void => {
      this.#dialogDetected = true;
      this.#dialog = observeDialog(dialog, false);

      if (!options.handleDialog) return;
      const actionToTake = typeof options.handleDialog === 'object'
        ? options.handleDialog[dialog.type()]
        : options.handleDialog;
      if (!actionToTake) return;

      this.#dialogHandled = true;
      this.#dialog = observeDialog(dialog, true);
      if (actionToTake === 'dismiss') {
        void dialog.dismiss();
      } else if (actionToTake === 'accept') {
        void dialog.accept();
      } else {
        void dialog.accept(actionToTake);
      }
    };
    this.#page.on('dialog', dialogHandler);
    this.#abortController.signal.addEventListener('abort', () => {
      this.#page.off('dialog', dialogHandler);
    }, { once: true });

    const navigationFinished = this.#waitForNavigationStarted()
      .then(async (navigationStarted) => {
        this.#navigationObserved = navigationStarted;
        if (!navigationStarted) return;
        await this.#page.waitForNavigation({
          timeout: options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
          signal: this.#abortController.signal,
        });
      })
      .catch(() => undefined);

    try {
      await action();
    } catch (error) {
      this.#abortController.abort();
      throw error;
    }

    let domSettled = false;
    try {
      await navigationFinished;
      if (!this.#dialogDetected) {
        domSettled = await this.#waitForStableDom();
      }
    } catch {
      // Upstream treats navigation and stable-DOM waits as post-action observations.
    } finally {
      this.#abortController.abort();
    }

    return this.#result(domSettled);
  }

  async #waitForStableDom(): Promise<boolean> {
    const stableDomObserver = await Promise.race([
      this.#page.evaluateHandle((stableFor: number) => {
        let timeoutId: ReturnType<typeof setTimeout>;
        const callback = () => {
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => {
            domObserver.resolver.resolve();
            domObserver.observer.disconnect();
          }, stableFor);
        };
        let resolveObserver!: () => void;
        const observerPromise = new Promise<void>((resolve) => {
          resolveObserver = resolve;
        });
        const domObserver: StableDomObserver = {
          resolver: { promise: observerPromise, resolve: resolveObserver },
          observer: new MutationObserver(callback),
        };
        callback();
        domObserver.observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
        });
        return domObserver;
      }, STABLE_DOM_FOR_MS),
      this.#timeout(STABLE_DOM_TIMEOUT_MS).then(() => undefined),
    ]).catch(() => undefined);

    if (!stableDomObserver) return false;

    this.#abortController.signal.addEventListener('abort', () => {
      void resolveStableDomObserver(stableDomObserver);
    }, { once: true });

    try {
      await Promise.race([
        stableDomObserver.evaluate(async (observer: StableDomObserver) => {
          await observer.resolver.promise;
        }),
        this.#timeout(STABLE_DOM_TIMEOUT_MS).then(() => {
          throw new Error('Timeout');
        }),
      ]);
      return true;
    } finally {
      // Puppeteer's explicit resource-management hook is also non-blocking.
      void stableDomObserver.dispose();
    }
  }

  async #waitForNavigationStarted(): Promise<boolean> {
    const navigationStarted = new Promise<boolean>((resolve) => {
      const listener = (event: Protocol.Page.FrameStartedNavigatingEvent): void => {
        if (
          ['historySameDocument', 'historyDifferentDocument', 'sameDocument'].includes(
            event.navigationType
          )
        ) {
          resolve(false);
          return;
        }
        resolve(true);
      };

      this.#page._client().on('Page.frameStartedNavigating', listener);
      this.#abortController.signal.addEventListener('abort', () => {
        resolve(false);
        this.#page._client().off('Page.frameStartedNavigating', listener);
      }, { once: true });
    });

    return Promise.race([
      navigationStarted,
      this.#timeout(EXPECT_NAVIGATION_WITHIN_MS).then(() => false),
    ]);
  }

  #timeout(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      this.#abortController.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  #result(domSettled: boolean): ActionReceipt {
    const finalUrl = this.#page.url();
    return {
      navigated: this.#navigationObserved || finalUrl !== this.#initialUrl,
      ...(finalUrl !== this.#initialUrl ? { navigatedToUrl: finalUrl } : {}),
      domSettled,
      ...(this.#dialog ? {
        dialog: { ...this.#dialog, handled: this.#dialogHandled },
      } : {}),
      openedPageIds: Object.freeze([]),
      closedPageIds: Object.freeze([]),
    };
  }
}

async function resolveStableDomObserver(
  observerHandle: JSHandle<StableDomObserver>
): Promise<void> {
  await observerHandle.evaluate((observer: StableDomObserver) => {
    observer.observer.disconnect();
    observer.resolver.resolve();
  }).catch(() => undefined);
}

function observeDialog(dialog: Dialog, handled: boolean): DialogObservation {
  return {
    type: dialog.type(),
    message: dialog.message(),
    defaultValue: dialog.defaultValue(),
    handled,
  };
}
