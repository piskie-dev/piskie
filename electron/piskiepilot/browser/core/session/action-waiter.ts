/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/utils/WaitForHelper.ts.
 * Host cancellation and dialog observations use a transport-free action receipt.
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
  readonly dialogHandled?: boolean;
  /** Only the source handler's recognized interaction interruption sets this flag. */
  readonly interrupted?: boolean;
  readonly interruptedUid?: string;
  readonly openedPageIds: readonly number[];
  readonly closedPageIds: readonly number[];
}

export type DialogAction = 'accept' | 'dismiss' | string;

export interface ActionWaitOptions {
  readonly pageId?: number;
  readonly signal?: AbortSignal;
  readonly navigationTimeoutMs?: number;
  readonly waitForStableDom?: boolean;
  readonly expectNavigationIn?: number;
  readonly handleDialog?: DialogAction | Readonly<Record<string, DialogAction>>;
}

type ActionPage = Page & { _client(): CDPSession };
interface StableDomObserver {
  readonly resolver: { readonly promise: Promise<void>; readonly resolve: () => void };
  readonly observer: MutationObserver;
}

/** Navigation observation begins before dispatch and stays active throughout the action. */
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

  async run(action: (signal: AbortSignal) => Promise<unknown>, options: ActionWaitOptions = {}): Promise<ActionReceipt> {
    if (this.#abortController.signal.aborted) throw new Error("Can't re-use an ActionWaiter");
    options.signal?.throwIfAborted();
    const signal = this.#abortController.signal;
    const cancel = () => this.#abortController.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', cancel, { once: true });

    const dialogHandler = (dialog: Dialog): void => {
      this.#dialogDetected = true;
      this.#dialog = observeDialog(dialog, false);
      const actionToTake = typeof options.handleDialog === 'object'
        ? options.handleDialog[dialog.type()] : options.handleDialog;
      if (actionToTake) {
        this.#dialogHandled = true;
        this.#dialog = observeDialog(dialog, true);
        if (actionToTake === 'dismiss') void dialog.dismiss();
        else if (actionToTake === 'accept') void dialog.accept();
        else void dialog.accept(actionToTake);
      } else {
        this.#abortController.abort(new Error('Action interrupted by a dialog'));
      }
    };
    this.#page.on('dialog', dialogHandler);
    signal.addEventListener('abort', () => this.#page.off('dialog', dialogHandler), { once: true });

    const navigationAbort = new AbortController();
    let resolveNavigation!: (value: boolean) => void;
    const navigationStartedPromise = new Promise<boolean>((resolve) => { resolveNavigation = resolve; });
    const mainFrameId = () => (this.#page.mainFrame() as unknown as { _id: string })._id;
    const navigationListener = (event: Protocol.Page.FrameStartedNavigatingEvent): void => {
      if (event.frameId !== mainFrameId()) return;
      if (event.navigationType === 'sameDocument' || event.navigationType === 'historySameDocument') return;
      resolveNavigation(true);
    };
    const requestedNavigationListener = (event: Protocol.Page.FrameRequestedNavigationEvent): void => {
      if (event.frameId === mainFrameId()) resolveNavigation(true);
    };
    const client = this.#page._client();
    client.on('Page.frameStartedNavigating', navigationListener);
    client.on('Page.frameRequestedNavigation', requestedNavigationListener);
    navigationAbort.signal.addEventListener('abort', () => {
      client.off('Page.frameStartedNavigating', navigationListener);
      client.off('Page.frameRequestedNavigation', requestedNavigationListener);
    }, { once: true });
    signal.addEventListener('abort', () => { resolveNavigation(false); navigationAbort.abort(); }, { signal: navigationAbort.signal });

    // The public Page type omits the internal Frame navigation option used by the fixed source.
    const navigationOptions = { timeout: 0, signal, ignoreSameDocumentNavigation: true };
    const navigationFinished = this.#page.waitForNavigation(navigationOptions)
      .then((result) => { resolveNavigation(true); return result; })
      .catch(() => undefined);

    let domSettled = false;
    try {
      await action(signal);
      const navigationStarted = await Promise.race([
        navigationStartedPromise,
        this.#timeout(options.expectNavigationIn ?? EXPECT_NAVIGATION_WITHIN_MS).then(() => {
          resolveNavigation(false);
          return false;
        }),
      ]);
      this.#navigationObserved = navigationStarted;
      navigationAbort.abort();
      try {
        if (navigationStarted) {
          await Promise.race([navigationFinished, this.#timeout(options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS)]);
        }
        if (!this.#dialogDetected && options.waitForStableDom !== false) {
          domSettled = await this.#waitForStableDom();
        }
      } catch { /* Source treats navigation/DOM completion as post-action observations. */ }
      options.signal?.throwIfAborted();
      return this.#result(domSettled);
    } finally {
      this.#abortController.abort();
      navigationAbort.abort();
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  async #waitForStableDom(): Promise<boolean> {
    const stableDomObserver = await Promise.race([
      this.#page.evaluateHandle((stableFor: number) => {
        let timeoutId: ReturnType<typeof setTimeout>;
        const callback = () => {
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => { domObserver.resolver.resolve(); domObserver.observer.disconnect(); }, stableFor);
        };
        let resolveObserver!: () => void;
        const observerPromise = new Promise<void>((resolve) => { resolveObserver = resolve; });
        const domObserver: StableDomObserver = {
          resolver: { promise: observerPromise, resolve: resolveObserver },
          observer: new MutationObserver(callback),
        };
        callback();
        domObserver.observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        return domObserver;
      }, STABLE_DOM_FOR_MS),
      this.#timeout(STABLE_DOM_TIMEOUT_MS).then(() => undefined),
    ]).catch(() => undefined);
    if (!stableDomObserver) return false;
    this.#abortController.signal.addEventListener('abort', () => { void resolveStableDomObserver(stableDomObserver); }, { once: true });
    try {
      await Promise.race([
        stableDomObserver.evaluate(async (observer: StableDomObserver) => { await observer.resolver.promise; }),
        this.#timeout(STABLE_DOM_TIMEOUT_MS).then(() => { throw new Error('Timeout'); }),
      ]);
      return true;
    } finally { void stableDomObserver.dispose(); }
  }

  #timeout(milliseconds: number): Promise<void> {
    if (this.#abortController.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      this.#abortController.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  #result(domSettled: boolean): ActionReceipt {
    const finalUrl = this.#page.url();
    return {
      navigated: this.#navigationObserved || finalUrl !== this.#initialUrl,
      ...(finalUrl !== this.#initialUrl ? { navigatedToUrl: finalUrl } : {}),
      domSettled,
      dialogHandled: this.#dialogHandled,
      ...(this.#dialog ? { dialog: { ...this.#dialog, handled: this.#dialogHandled } } : {}),
      openedPageIds: Object.freeze([]), closedPageIds: Object.freeze([]),
    };
  }
}

async function resolveStableDomObserver(observerHandle: JSHandle<StableDomObserver>): Promise<void> {
  await observerHandle.evaluate((observer: StableDomObserver) => {
    observer.observer.disconnect(); observer.resolver.resolve();
  }).catch(() => undefined);
}

function observeDialog(dialog: Dialog, handled: boolean): DialogObservation {
  return { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue(), handled };
}
