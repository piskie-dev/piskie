/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 McpContext, McpPage, and input
 * tools. MCP transport and response plumbing were replaced by Piskie's
 * BrowserManager-owned session and browser contracts.
 */

import {
  Locator,
  TimeoutError,
  type Browser,
  type Dialog,
  type ElementHandle,
  type HTTPRequest,
  type Page,
} from 'puppeteer-core';
import { ActionWaiter, type ActionReceipt, type ActionWaitOptions, type DialogObservation } from './action-waiter.js';
import { BrowserInputDriver, type OperationToken } from './browser-input-driver.js';
import { readOperationTarget, resolveOperationFocus } from './operation-target.js';
import { PageOperationFeedback } from './page-operation-feedback.js';
import type { SuccessfulScreenInput } from '../browser/screen-caster.js';
export { uploadFileThroughElement } from './browser-input-driver.js';
import type { ConsoleCollector, ConsoleObservation, NetworkCollector } from './page-collector.js';
import type { ServiceWorkerConsoleCollector } from './service-worker-console.js';
import { PageRegistry, type PageChangeSet, type RegisteredPage } from './page-registry.js';
import {
  createTextSnapshot,
  resolveSnapshotElement,
  type TextSnapshotNode,
  type TextSnapshotResult,
} from './text-snapshot.js';

import { sameScreenPage, sameScreenPageInstance, type ScreenElementTarget, type ScreenInputActor, type ScreenOperationKind, type ScreenPageIdentity, type ScreenPointer } from '@shared/types/stream.js';
import { isRecentScreenPress, reduceScreenPointer, SCREEN_POINTER_POLICY } from '@shared/screen-pointer.js';
import { MouseObserver } from './mouse-observer.js';
import { raceAbort } from '@electron/utils/abort.js';

export interface BrowserScreenTarget {
  readonly page: Page;
  readonly identity: ScreenPageIdentity;
}

export type BrowserScreenEvent =
  | { readonly type: 'target'; readonly target: BrowserScreenTarget | null }
  | { readonly type: 'pointer'; readonly pointer: ScreenPointer }
  | { readonly type: 'feedback'; readonly pointer: ScreenPointer };

let nextSessionGeneration = 1;

interface TargetFrame {
  readonly timestamp: number;
  readonly seq?: number;
}

interface TrackedOperationTarget {
  readonly token: OperationToken;
  readonly handle: ElementHandle<Element>;
  refreshing?: boolean;
  pendingFrame?: TargetFrame;
  pendingLocal?: boolean;
  checkTimer?: ReturnType<typeof setTimeout>;
}

interface PageSnapshotState {
  readonly identityMap: Map<string, string>;
  snapshot?: TextSnapshotResult;
}

export interface BrowserTargetOptions {
  readonly feedback?: boolean;
  readonly signal?: AbortSignal;
}

export class BrowserDialogOpenError extends Error {
  readonly dialog: DialogObservation;

  constructor(dialog: DialogObservation) {
    super(`A dialog is open (${dialog.type}: ${dialog.message}).`);
    this.name = 'BrowserDialogOpenError';
    this.dialog = dialog;
  }
}

export class BrowserAutomationSession {
  readonly browser: Browser;
  readonly generation: string;
  #registry!: PageRegistry;
  readonly #pageSnapshots = new Map<number, PageSnapshotState>();
  #targetPageId: number | undefined;
  #displayPageId: number | undefined;
  #executionSignal: AbortSignal | undefined;
  #disposed = false;
  readonly input: BrowserInputDriver;
  readonly #pagePointers = new Map<number, ScreenPointer>();
  readonly #targetHandles = new Map<number, TrackedOperationTarget>();
  readonly #screenFrames = new Map<number, TargetFrame & { identity: ScreenPageIdentity }>();
  readonly #targetOrders = new Map<number, number>();
  readonly #screenSequences = new Map<number, number>();
  #screenSequence = 0;
  #revision = 0;
  #operationDepth = 0;
  readonly #feedbackDelays = new Set<() => void>();
  readonly #screenListeners = new Set<(event: BrowserScreenEvent) => void>();

  private constructor(browser: Browser) {
    this.browser = browser;
    this.generation = `connection-${nextSessionGeneration++}`;
    this.input = new BrowserInputDriver({
      begin: (page, kind, actor) => this.#beginOperation(page, kind, actor),
      finish: (token) => this.#finishOperation(token),
      element: (token, handle) => this.#observeElement(token, handle),
      focus: (token, page) => this.#observeFocus(token, page),
    });
  }

  static async create(browser: Browser): Promise<BrowserAutomationSession> {
    const session = new BrowserAutomationSession(browser);
    session.#registry = await PageRegistry.create(browser, {
      selectedPageChanged: (previousPageId, pageId) => {
        if (session.#operationDepth === 0 && previousPageId !== undefined && previousPageId !== pageId) {
          session.#clearPageFeedback(previousPageId);
          if (pageId !== undefined) session.#clearPageFeedback(pageId);
        }
      },
      pageRemoved: (pageId) => {
        session.#pageSnapshots.delete(pageId);
        if (session.#displayPageId === pageId) session.#publishScreen({ type: 'target', target: null });
      },
      mainFrameNavigated: (pageId) => {
        session.#releaseTarget(pageId);
        if (session.#currentScreenPage()?.pageId === pageId) {
          session.#publishScreen({ type: 'target', target: session.getScreenTarget() });
        }
      },
      frameChanged: (registered, frame) => {
        session.#screenSequences.set(registered.pageId, (session.#screenSequences.get(registered.pageId) ?? 0) + 1);
        session.#releaseTarget(registered.pageId);
        const pointer = session.#pagePointers.get(registered.pageId);
        if (pointer) {
          const activity = { page: session.#screenTarget(registered).identity, seq: ++session.#screenSequence,
            timestamp: Date.now(), kind: 'navigation' as const, actor: 'ai' as const, pending: false };
          session.#pagePointers.set(registered.pageId, { ...pointer, activity,
            positionTarget: pointer.target ?? pointer.positionTarget, target: undefined, revision: ++session.#revision });
        }
        // Main navigation is published after the registry commits its snapshot identity.
        if (frame === registered.page.mainFrame()) return;
        if (session.#registry && !registered.page.isClosed()
          && session.#currentScreenPage()?.pageId === registered.pageId) {
          session.#publishScreen({ type: 'target', target: session.#screenTarget(registered) });
        }
      },
      screenChanged: (registered) => {
        if (session.#displayPageId !== undefined && !session.#disposed) return;
        session.#publishScreen({ type: 'target', target: registered ? session.#screenTarget(registered) : null });
      },
      observeMouse: (page, current) => {
        const identity = session.#screenTarget(current()).identity;
        session.#screenSequences.set(identity.pageId, 0);
        session.#pagePointers.set(identity.pageId, session.#initialPointer(identity));
        const observer = new MouseObserver(page.mouse,
          () => ({ identity: session.#screenTarget(current()).identity, order: ++session.#screenSequence }),
          ({ identity: origin, order }, action) => session.#publishScreen({ type: 'pointer', pointer: {
            ...action, page: origin, origin: 'mouse', actor: 'ai', sourceOrder: order,
          } }));
        return () => {
          observer.dispose();
          session.#pagePointers.delete(identity.pageId);
          session.#targetOrders.delete(identity.pageId);
          session.#screenSequences.delete(identity.pageId);
          session.#screenFrames.delete(identity.pageId);
          session.#releaseTarget(identity.pageId);
        };
      },
    });
    return session;
  }

  getScreenTarget(): BrowserScreenTarget | null {
    const registered = this.#currentScreenPage();
    return registered ? this.#screenTarget(registered) : null;
  }

  #currentScreenPage(): RegisteredPage | undefined {
    if (this.#disposed || !this.#registry) return undefined;
    if (this.#displayPageId !== undefined) return this.#registry.pageById(this.#displayPageId);
    try { return this.#registry.selectedPage(); } catch { return undefined; }
  }

  subscribeScreen(listener: (event: BrowserScreenEvent) => void): () => void {
    this.#screenListeners.add(listener);
    const pointer = this.getCurrentScreenPointer();
    if (pointer) {
      try { listener({ type: pointer.origin === 'initial' ? 'feedback' : 'pointer', pointer }); }
      catch { /* Screen consumers cannot fail browser execution. */ }
    }
    return () => this.#screenListeners.delete(listener);
  }

  getCurrentScreenPointer(): ScreenPointer | null {
    if (this.#disposed) return null;
    const pageId = this.#currentScreenPage()?.pageId;
    if (pageId === undefined) return null;
    const pointer = this.#pagePointers.get(pageId);
    if (!pointer) return null;
    if (pointer.press && !isRecentScreenPress(pointer.press.timestamp, Date.now())) {
      const expired = { ...pointer, press: undefined };
      this.#pagePointers.set(pageId, expired);
      return expired;
    }
    return pointer;
  }

  #screenTarget(registered: RegisteredPage): BrowserScreenTarget {
    return {
      page: registered.page,
      identity: {
        connectionId: this.generation,
        pageId: registered.pageId,
        navigationSequence: this.#screenSequences.get(registered.pageId) ?? 0,
      },
    };
  }

  #clearPageFeedback(pageId: number): void {
    const pointer = this.#pagePointers.get(pageId);
    if (!pointer) return;
    this.#releaseTarget(pageId);
    this.#pagePointers.set(pageId, { ...pointer, press: undefined, activity: undefined,
      positionTarget: pointer.target ?? pointer.positionTarget, target: undefined, revision: ++this.#revision });
  }

  #initialPointer(page: ScreenPageIdentity): ScreenPointer {
    return { page, seq: 0, timestamp: Date.now(), action: 'initialize', origin: 'initial',
      x: SCREEN_POINTER_POLICY.initialInset, y: SCREEN_POINTER_POLICY.initialInset, buttons: 0, clickCount: 0 };
  }

  #publishScreen(event: BrowserScreenEvent): void {
    if (event.type !== 'target') {
      const before = this.#pagePointers.get(event.pointer.page.pageId);
      if (!before || this.#disposed) return;
      const pointer = reduceScreenPointer(before, event.pointer);
      if (pointer === before) return;
      if (!pointer.target) this.#releaseTarget(event.pointer.page.pageId);
      this.#storePointer({ ...pointer, revision: ++this.#revision }, 'pointer');
      return;
    }
    this.#notifyScreen(event);
  }

  #storePointer(pointer: ScreenPointer, type: 'pointer' | 'feedback' = 'feedback'): void {
    if (this.#disposed || !this.#pagePointers.has(pointer.page.pageId)) return;
    this.#pagePointers.set(pointer.page.pageId, pointer);
    if (!this.#registry || !sameScreenPageInstance(pointer.page, this.getCurrentScreenPointer()?.page)) return;
    this.#notifyScreen({ type, pointer });
  }

  #notifyScreen(event: BrowserScreenEvent): void {
    for (const listener of this.#screenListeners) {
      try { listener(event); } catch { /* The screen is a passive consumer. */ }
    }
  }

  #identityFor(page: Page): ScreenPageIdentity | null {
    if (this.#disposed) return null;
    const registered = this.#registry.pages().find((entry) => entry.page === page);
    return registered ? this.#screenTarget(registered).identity : null;
  }

  #beginOperation(page: Page, kind: ScreenOperationKind, actor: ScreenInputActor = 'ai'): OperationToken | null {
    const identity = this.#identityFor(page);
    if (!identity) return null;
    const token = { page: identity, seq: ++this.#screenSequence, timestamp: Date.now(), kind, actor };
    if (kind === 'input' || kind === 'select' || kind === 'upload' || kind === 'key') this.#targetOrders.set(identity.pageId, token.seq);
    const pointer = this.#pagePointers.get(identity.pageId)!;
    this.#storePointer({ ...pointer, revision: ++this.#revision, activity: { ...token, pending: true } });
    return token;
  }

  #finishOperation(token: OperationToken): void {
    const pointer = this.#pagePointers.get(token.page.pageId);
    if (pointer?.activity?.seq !== token.seq || this.#disposed) return;
    this.#storePointer({ ...pointer, revision: ++this.#revision,
      activity: { ...pointer.activity, pending: false, timestamp: Date.now() } });
  }

  #observeElement(token: OperationToken, handle: ElementHandle<Element>): void {
    // Retain a separate public handle before the caller releases its locator/UID handle.
    try {
      void handle.evaluateHandle((element) => element).then(async (remote) => {
        const owned = remote.asElement() as ElementHandle<Element> | null;
        if (!owned) { void remote.dispose(); return; }
        await this.#adoptTarget(token, owned);
      }).catch(() => undefined);
    } catch { /* The successful input does not wait for a retained telemetry handle. */ }
  }

  #observeFocus(token: OperationToken, page: Page): void {
    if (this.#disposed || this.#registry.getDialog(token.page.pageId)) return;
    void resolveOperationFocus(page).then(async (handle) => {
      if (handle) await this.#adoptTarget(token, handle);
    }).catch(() => undefined);
  }

  async #adoptTarget(token: OperationToken, handle: ElementHandle<Element>, frameAfter?: number, expected?: TrackedOperationTarget): Promise<void> {
    let retained = false;
    const before = expected ? this.#pagePointers.get(token.page.pageId)?.target : undefined;
    try {
      if (expected && this.#targetHandles.get(token.page.pageId) !== expected) return;
      const geometry = await readOperationTarget(handle);
      const identity = this.#identityFor(handle.frame.page());
      const pointer = this.#pagePointers.get(token.page.pageId);
      if (!pointer || !sameScreenPage(identity, token.page)
        || (expected && (this.#targetHandles.get(token.page.pageId) !== expected || pointer.target !== before))
        || token.seq < (this.#targetOrders.get(token.page.pageId) ?? 0)
        || token.seq < (pointer.target?.seq ?? pointer.positionTarget?.seq ?? 0) || token.seq < (pointer.sourceOrder ?? 0)) return;
      if (!geometry) {
        this.#releaseTarget(token.page.pageId);
        this.#storePointer({ ...pointer, positionTarget: pointer.target ?? pointer.positionTarget, target: undefined, revision: ++this.#revision });
        return;
      }
      const kind = token.kind === 'operation' || token.kind === 'scroll' ? 'focus' : token.kind;
      if (kind !== 'input' && kind !== 'select' && kind !== 'upload' && kind !== 'key' && kind !== 'focus') return;
      if (this.#currentScreenPage()?.pageId !== token.page.pageId) {
        const positionTarget: ScreenElementTarget = { ...geometry, ...token, kind, timestamp: Date.now() };
        this.#storePointer({ ...pointer, target: undefined, positionTarget, revision: ++this.#revision });
        return;
      }
      const frame = this.#screenFrames.get(token.page.pageId);
      const frameTimestamp = sameScreenPage(frame?.identity, token.page) ? frame?.timestamp : undefined;
      this.#releaseTarget(token.page.pageId);
      const tracked: TrackedOperationTarget = { token, handle };
      this.#targetHandles.set(token.page.pageId, tracked);
      retained = true;
      const target: ScreenElementTarget = { ...geometry, ...token, kind, frameAfter, frameBefore: frameTimestamp,
        frameSeq: frameTimestamp !== undefined ? frame?.seq : undefined,
        timestamp: pointer.target?.seq === token.seq ? pointer.target.timestamp : Date.now() };
      this.#storePointer({ ...pointer, target, positionTarget: undefined, revision: ++this.#revision });
      this.#scheduleTargetCheck(tracked);
    } catch { /* Feedback cannot fail or replay input. */ }
    finally { if (!retained) void handle.dispose(); }
  }

  refreshTargetForFrame(identity: ScreenPageIdentity, geometry: { width?: number; height?: number; scrollX?: number; scrollY?: number; timestamp: number; seq?: number }): void {
    if (this.#disposed || !sameScreenPage(this.getScreenTarget()?.identity, identity)) return;
    const last = this.#screenFrames.get(identity.pageId);
    if (sameScreenPage(last?.identity, identity)
      && (geometry.seq === undefined ? geometry.timestamp <= last!.timestamp
        : geometry.seq === last!.seq && geometry.timestamp === last!.timestamp)) return;
    this.#screenFrames.set(identity.pageId, { identity, timestamp: geometry.timestamp, seq: geometry.seq });
    const tracked = this.#targetHandles.get(identity.pageId);
    if (!tracked || !sameScreenPage(tracked.token.page, identity)) return;
    tracked.pendingFrame = { timestamp: geometry.timestamp, seq: geometry.seq };
    this.#refreshTarget(tracked);
  }

  #scheduleTargetCheck(tracked: TrackedOperationTarget): void {
    const target = this.#pagePointers.get(tracked.token.page.pageId)?.target;
    if (this.#targetHandles.get(tracked.token.page.pageId) !== tracked || !target || tracked.checkTimer
      || Date.now() - target.timestamp > SCREEN_POINTER_POLICY.feedbackFreshnessMs) return;
    // A finite DOM change can be skipped by lower-fps screencast sampling. Check only the fresh retained target.
    tracked.checkTimer = setTimeout(() => {
      tracked.checkTimer = undefined;
      if (this.#targetHandles.get(tracked.token.page.pageId) !== tracked) return;
      tracked.pendingLocal = true;
      this.#refreshTarget(tracked);
    }, SCREEN_POINTER_POLICY.targetObservationMs);
  }

  #refreshTarget(tracked: TrackedOperationTarget): void {
    if (tracked.refreshing) return;
    tracked.refreshing = true;
    void this.#refreshTargetFrames(tracked).finally(() => {
      tracked.refreshing = false;
      this.#scheduleTargetCheck(tracked);
    });
  }

  async #refreshTargetFrames(tracked: TrackedOperationTarget): Promise<void> {
    const { token, handle } = tracked;
    // Read only a retained active target. Coalesce new frames while one public geometry read is in flight.
    while ((tracked.pendingFrame !== undefined || tracked.pendingLocal) && this.#targetHandles.get(token.page.pageId) === tracked) {
      const frame = tracked.pendingFrame;
      tracked.pendingFrame = undefined;
      tracked.pendingLocal = false;
      const geometry = await readOperationTarget(handle).catch(() => null);
      if (this.#targetHandles.get(token.page.pageId) !== tracked
        || !sameScreenPage(this.#identityFor(handle.frame.page()), token.page)) return;
      if (tracked.pendingFrame !== undefined) continue;
      const pointer = this.#pagePointers.get(token.page.pageId);
      if (pointer?.target?.seq !== token.seq) return;
      if (!geometry) {
        this.#releaseTarget(token.page.pageId);
        const positionTarget = frame ? pointer.target : { ...pointer.target, frameAfter: Date.now() };
        this.#storePointer({ ...pointer, positionTarget, target: undefined, revision: ++this.#revision });
        return;
      }
      if (frame) {
        this.#storePointer({ ...pointer, positionTarget: undefined,
          target: { ...pointer.target, ...geometry, frameAfter: frame.timestamp, frameBefore: frame.timestamp, frameSeq: frame.seq },
          revision: ++this.#revision });
      } else {
        const target = pointer.target;
        if (target.x === geometry.x && target.y === geometry.y && target.scrollX === geometry.scrollX && target.scrollY === geometry.scrollY
          && Object.entries(geometry.rect).every(([key, value]) => target.rect[key as keyof typeof target.rect] === value)) continue;
        // Keep the last painted position; changed DOM geometry cannot highlight an older image.
        this.#storePointer({ ...pointer, positionTarget: pointer.positionTarget ?? target,
          target: { ...target, ...geometry, frameAfter: Date.now() }, revision: ++this.#revision });
      }
    }
  }

  #releaseTarget(pageId: number): void {
    const tracked = this.#targetHandles.get(pageId);
    if (tracked?.checkTimer) clearTimeout(tracked.checkTimer);
    void tracked?.handle.dispose();
    this.#targetHandles.delete(pageId);
  }

  async #feedbackDelay(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.#feedbackDelays.delete(done); resolve(); };
      const timer = setTimeout(done, delayMs);
      this.#feedbackDelays.add(done);
      if (this.#disposed) done();
    });
  }

  /** One target scope shared by model page IDs and the SDK's internal page adapter. */
  async withTarget<T>(pageId: number | undefined, action: (page: Page) => Promise<T> | T, options: BrowserTargetOptions = {}): Promise<T> {
    const registered = this.#requirePage(pageId);
    const previous = this.#targetPageId;
    this.#targetPageId = registered.pageId;
    try {
      return await this.withExecutionSignal(() => options.feedback
        ? this.withOperationFeedback(() => action(registered.page), 'ai', registered.pageId)
        : action(registered.page), options.signal);
    } finally { this.#targetPageId = previous; }
  }

  async withExecutionSignal<T>(action: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const previous = this.#executionSignal;
    this.#executionSignal = signal ?? previous;
    try { this.#executionSignal?.throwIfAborted(); return await action(); }
    finally { this.#executionSignal = previous; }
  }

  /** Shared feedback observes only the resolved operation Page, never changes logical selection. */
  async withOperationFeedback<T>(action: () => Promise<T> | T, actor: ScreenInputActor = 'ai', pageId?: number): Promise<T> {
    if (this.#operationDepth > 0) return action();
    const registered = this.#requirePage(pageId);
    const page = registered.page;
    this.#operationDepth++;
    this.#displayPageId = registered.pageId;
    this.#publishScreen({ type: 'target', target: this.#screenTarget(registered) });
    const token = this.#beginOperation(page, 'operation', actor);
    // Start sampling before dispatch, without making the business promise await feedback or drawing.
    const sample = this.#screenListeners.size && !this.#registry.getDialog(registered.pageId)
      ? PageOperationFeedback.capture(page).catch(() => null) : Promise.resolve(null);
    let restored = false;
    const restoreDisplay = () => {
      if (restored) return;
      restored = true;
      this.#displayPageId = undefined;
      const target = this.getScreenTarget();
      this.#publishScreen({ type: 'target', target });
      if (target?.identity.pageId !== registered.pageId) this.#clearPageFeedback(registered.pageId);
    };
    const cancellation = this.#executionSignal;
    cancellation?.addEventListener('abort', restoreDisplay, { once: true });
    try { return await action(); }
    finally {
      this.#operationDepth--;
      restoreDisplay();
      cancellation?.removeEventListener('abort', restoreDisplay);
      if (token) {
        this.#finishOperation(token);
        void sample.then(async (watch) => {
          if (!watch) return;
          try {
            if (this.#disposed || !sameScreenPage(this.#identityFor(page), token.page) || this.#registry.getDialog(registered.pageId)) return;
            let result = await watch.read();
            const deadline = Date.now() + SCREEN_POINTER_POLICY.scrollObservationMs;
            while (result.effects.changed && result.effects.at > 0
              && Date.now() - result.effects.at < SCREEN_POINTER_POLICY.scrollQuietMs && Date.now() < deadline) {
              void result.focus?.dispose();
              await this.#feedbackDelay(SCREEN_POINTER_POLICY.scrollQuietMs);
              if (this.#disposed || !sameScreenPage(this.#identityFor(page), token.page)) return;
              result = await watch.read();
            }
            if (result.effects.changed) {
              const scroll = this.#beginOperation(page, 'scroll', actor);
              if (scroll) {
                const pointer = this.#pagePointers.get(scroll.page.pageId)!;
                this.#storePointer({ ...pointer, revision: ++this.#revision,
                  activity: { ...scroll, pending: false, scroll: result.effects.scroll } });
              }
            }
            const tracked = this.#targetHandles.get(token.page.pageId);
            if (tracked && (tracked.token.seq > token.seq || !result.focusChanged)) {
              const remote = await tracked.handle.evaluateHandle((element) => element);
              const owned = remote.asElement() as ElementHandle<Element> | null;
              if (owned) await this.#adoptTarget(tracked.token, owned, result.effects.at || this.#pagePointers.get(token.page.pageId)?.target?.frameAfter, tracked);
              else void remote.dispose();
            } else if (result.focus && result.focusChanged) {
              await this.#adoptTarget({ ...token, kind: 'focus' }, result.focus, result.effects.at || undefined);
              result.focus = null;
            } else if (result.focusChanged && !result.focus) {
              const pointer = this.#pagePointers.get(token.page.pageId);
              if (pointer && token.seq >= (this.#targetOrders.get(token.page.pageId) ?? 0)) {
                this.#releaseTarget(token.page.pageId);
                this.#storePointer({ ...pointer, target: undefined, positionTarget: pointer.target ?? pointer.positionTarget, revision: ++this.#revision });
              }
            }
            void result.focus?.dispose();
          } catch { /* Closed/navigated documents have no current visible target. */ }
          finally { await watch.dispose(); }
        });
      }
    }
  }

  reserveInputOrder(): number { return ++this.#screenSequence; }

  observeManualInput(input: SuccessfulScreenInput): void {
    if (this.#disposed || !input.identity || !this.#pagePointers.has(input.identity.pageId)) return;
    const order = input.sourceOrder ?? ++this.#screenSequence;
    const { event } = input;
    if (event.kind === 'mouse') {
      this.#publishScreen({ type: 'pointer', pointer: { page: input.identity, seq: input.seq,
        timestamp: input.timestamp, x: event.x, y: event.y, buttons: event.buttons ?? 0,
        clickCount: event.clickCount ?? 0, origin: 'mouse', actor: 'manual', sourceOrder: order,
        action: event.type === 'mousePressed' ? 'down' : event.type === 'mouseReleased' ? 'up'
          : event.type === 'mouseWheel' ? 'wheel' : 'move' } });
      if (event.type === 'mouseWheel') {
        const current = this.#pagePointers.get(input.identity.pageId)!;
        if (order < (current.target?.seq ?? 0) || order < (current.activity?.seq ?? 0) || order < (current.sourceOrder ?? 0)) return;
        const token = this.#beginOperation(input.page, 'scroll', 'manual');
        if (token) {
          const pointer = this.#pagePointers.get(token.page.pageId)!;
          this.#storePointer({ ...pointer, revision: ++this.#revision, activity: { ...token, pending: false,
            scroll: { x: event.deltaX ?? 0, y: event.deltaY ?? 0 } } });
        }
      }
    } else if (event.kind === 'text' || event.type === 'keyDown' || event.type === 'char') {
      const identity = this.#identityFor(input.page);
      const pointer = this.#pagePointers.get(input.identity.pageId)!;
      if (!sameScreenPage(identity, input.identity) || order < (pointer.activity?.seq ?? 0)
        || order < (this.#targetOrders.get(input.identity.pageId) ?? 0) || order < (pointer.sourceOrder ?? 0)) return;
      const token: OperationToken = { page: input.identity, seq: order, timestamp: input.timestamp,
        kind: event.kind === 'text' ? 'input' : 'key', actor: 'manual' };
      this.#targetOrders.set(token.page.pageId, order);
      this.#storePointer({ ...pointer, revision: ++this.#revision, activity: { ...token, pending: false } });
      this.#observeFocus(token, input.page);
    }
  }

  getSelectedPage(): Page { return this.#registry.selectedPage().page; }
  getSelectedPageId(): number { return this.#registry.selectedPage().pageId; }
  getSelectedPageIndex(): number { return this.#registry.selectedPageIndex(); }
  getPageByIndex(pageIndex: number): Page { return this.#registry.pageByIndex(pageIndex).page; }
  getPageById(pageId: number): Page { return this.#requirePage(pageId).page; }
  getPage(pageId?: number): Page { return this.#requirePage(pageId).page; }

  async listPages(): Promise<readonly RegisteredPage[]> { return this.#registry.refresh(); }
  consumeSelectedPageFallback(): { wasClosed: boolean } | undefined { return this.#registry.consumeSelectedPageFallback(); }

  async selectPageByIndex(pageIndex: number): Promise<Page> {
    await this.#registry.refresh();
    return this.#registry.selectByIndex(pageIndex).page;
  }

  async selectPageById(pageId: number, bringToFront = false): Promise<Page> {
    const page = this.#registry.selectById(pageId).page;
    if (bringToFront) await page.bringToFront();
    return page;
  }

  async newPage(url?: string, timeoutMs?: number, options: { background?: boolean; isolatedContext?: string } = {}): Promise<Page> {
    const registered = await this.#registry.newPage(options);
    if (url !== undefined) {
      await this.waitForAction(() => registered.page.goto(url, { timeout: timeoutMs }), {
        pageId: registered.pageId, navigationTimeoutMs: timeoutMs,
      });
    }
    return registered.page;
  }

  async closePageByIndex(pageIndex: number): Promise<void> {
    await this.#registry.refresh();
    await this.#registry.closeByIndex(pageIndex);
  }

  async closePageById(pageId: number): Promise<void> {
    await this.#registry.closeById(pageId);
  }

  async takeSnapshot(verbose = false, pageId?: number): Promise<TextSnapshotResult> {
    this.#assertActive();
    const registered = this.#requirePage(pageId);
    const state = this.#snapshotState(registered.pageId);
    const result = await createTextSnapshot(registered.page, verbose, { identityMap: state.identityMap });
    state.snapshot = result;
    return result;
  }

  getActiveSnapshot(pageId?: number): TextSnapshotResult | undefined {
    return this.#pageSnapshots.get(this.#requirePage(pageId).pageId)?.snapshot;
  }

  getAXNodeByUid(uid: string, pageId?: number): TextSnapshotNode | undefined {
    return this.getActiveSnapshot(pageId)?.idToNode.get(uid);
  }

  async getElementByUid(uid: string, pageId?: number): Promise<ElementHandle<Element>> {
    const registered = this.#requirePage(pageId);
    return resolveSnapshotElement(this.#requireSnapshot(registered.pageId), uid, registered.pageId);
  }

  async clickByUid(uid: string, clickCount: 1 | 2 = 1, pageId?: number): Promise<ActionReceipt> {
    const registered = this.#requirePage(pageId);
    const handle = await this.getElementByUid(uid, registered.pageId);
    try {
      const node = this.getAXNodeByUid(uid, registered.pageId);
      try {
        return await this.waitForAction(async (signal) => {
          if (clickCount === 1 && node?.role === 'option' && await selectNativeOption(handle, this.input, signal)) return;
          await this.input.click(handle, clickCount, signal);
        }, { pageId: registered.pageId });
      } catch (error) {
        if (this.getDialog(registered.pageId)) return this.#interruptedReceipt(registered.pageId);
        throwActionError(error, uid);
      }
    } finally { void handle.dispose(); }
  }

  async hoverByUid(uid: string, pageId?: number): Promise<ActionReceipt> {
    const registered = this.#requirePage(pageId);
    const handle = await this.getElementByUid(uid, registered.pageId);
    try {
      try {
        return await this.waitForAction((signal) => this.input.hover(handle, signal), { pageId: registered.pageId });
      } catch (error) {
        if (this.getDialog(registered.pageId)) return this.#interruptedReceipt(registered.pageId);
        throwActionError(error, uid);
      }
    } finally { void handle.dispose(); }
  }

  async dragByUids(fromUid: string, toUid: string, pageId?: number): Promise<ActionReceipt> {
    const registered = this.#requirePage(pageId);
    const fromHandle = await this.getElementByUid(fromUid, registered.pageId);
    let toHandle: ElementHandle<Element> | undefined;
    try {
      toHandle = await this.getElementByUid(toUid, registered.pageId);
      return await this.waitForAction(() => this.input.drag(fromHandle, toHandle!), { pageId: registered.pageId });
    } finally { void fromHandle.dispose(); void toHandle?.dispose(); }
  }

  async uploadFileByUid(uid: string, filePaths: string | readonly string[], pageId?: number): Promise<void> {
    const registered = this.#requirePage(pageId);
    const handle = await this.getElementByUid(uid, registered.pageId);
    try {
      await this.withOperationFeedback(() => this.input.upload(registered.page, handle, filePaths), 'ai', registered.pageId);
    } finally { void handle.dispose(); }
  }

  fillByUid(uid: string, value: string, pageId?: number): Promise<ActionReceipt> {
    return this.fillFormByUids([{ uid, value }], pageId);
  }

  async fillFormByUids(elements: readonly Readonly<{ uid: string; value: string }>[], pageId?: number): Promise<ActionReceipt> {
    const registered = this.#requirePage(pageId);
    let currentUid: string | undefined;
    try {
      return await this.waitForAction(async (signal) => {
        for (const { uid, value } of elements) {
          const previousUid = currentUid;
          currentUid = undefined;
          const handle = await raceAbort(this.getElementByUid(uid, registered.pageId), signal).catch((error) => {
            if (signal.aborted && previousUid) currentUid = previousUid;
            throw error;
          });
          currentUid = uid;
          try {
            const node = this.getAXNodeByUid(uid, registered.pageId);
            const options = node?.role === 'combobox' ? node.children.filter((child) => child.role === 'option') : [];
            if (options.length) {
              await raceAbort(selectOptionByText(handle, options, value, this.input, signal), signal);
            } else {
              const fillTimeout = registered.page.getDefaultTimeout() + value.length * 10;
              await raceAbort(this.input.fill(handle, value, fillTimeout, 'boolean-text', signal), signal);
            }
            signal.throwIfAborted();
          } finally { void handle.dispose(); }
        }
      }, { pageId: registered.pageId });
    } catch (error) {
      if (!currentUid) throw error;
      if (this.getDialog(registered.pageId)) return { ...this.#interruptedReceipt(registered.pageId), interruptedUid: currentUid };
      throwActionError(error, currentUid);
    }
  }

  async typeText(text: string, submitKey?: string, pageId?: number): Promise<ActionReceipt> {
    const registered = this.#requirePage(pageId);
    return this.waitForAction(() => this.input.typeText(registered.page, text, submitKey), { pageId: registered.pageId });
  }

  async pressKey(keyInput: string, pageId?: number): Promise<ActionReceipt> {
    const registered = this.#requirePage(pageId);
    return this.waitForAction(() => this.input.press(registered.page, keyInput), { pageId: registered.pageId });
  }

  async waitForTextOnPage(text: readonly string[], timeoutMs?: number, pageId?: number): Promise<void> {
    const frames = this.getPage(pageId).frames();
    let locator = Locator.race(frames.flatMap((frame) => text.flatMap((value) => [
      frame.locator(`aria/${value}`), frame.locator(`text/${value}`),
    ])));
    if (timeoutMs) locator = locator.setTimeout(timeoutMs);
    await locator.wait({ signal: this.#executionSignal });
  }

  getConsoleCollector(pageId?: number): ConsoleCollector {
    return this.#registry.getConsoleCollector(this.#requirePage(pageId).pageId);
  }
  getNetworkCollector(pageId?: number): NetworkCollector {
    return this.#registry.getNetworkCollector(this.#requirePage(pageId).pageId);
  }
  getServiceWorkerConsoleCollector(): ServiceWorkerConsoleCollector { return this.#registry.getServiceWorkerConsoleCollector(); }
  getServiceWorkerConsoleData(serviceWorkerId: string): readonly ConsoleObservation[] {
    return this.getServiceWorkerConsoleCollector().getData(serviceWorkerId);
  }
  getServiceWorkerConsoleMessageId(message: ConsoleObservation): number {
    return this.getServiceWorkerConsoleCollector().getIdForResource(message as Parameters<ServiceWorkerConsoleCollector['getIdForResource']>[0]);
  }

  getConsoleData(includePreservedMessages = false, pageId?: number): readonly ConsoleObservation[] {
    return this.#registry.getConsoleData(includePreservedMessages, this.#requirePage(pageId).pageId);
  }
  getConsoleMessageById(messageId: number, pageId?: number): ConsoleObservation {
    return this.#registry.getConsoleMessageById(messageId, this.#requirePage(pageId).pageId);
  }
  getConsoleMessageId(message: ConsoleObservation, pageId?: number): number {
    return this.#registry.getConsoleMessageId(message, this.#requirePage(pageId).pageId);
  }
  getNetworkRequests(includePreservedRequests = false, pageId?: number): readonly HTTPRequest[] {
    return this.#registry.getNetworkRequests(includePreservedRequests, this.#requirePage(pageId).pageId);
  }
  getNetworkRequestById(requestId: number, pageId?: number): HTTPRequest {
    return this.#registry.getNetworkRequestById(requestId, this.#requirePage(pageId).pageId);
  }
  getNetworkRequestId(request: HTTPRequest, pageId?: number): number {
    return this.#registry.getNetworkRequestId(request, this.#requirePage(pageId).pageId);
  }

  async waitForAction(action: (signal: AbortSignal) => Promise<unknown>, options: ActionWaitOptions = {}): Promise<ActionReceipt> {
    this.#assertActive();
    const registered = this.#requirePage(options.pageId);
    const before = new Set(this.#registry.pages().map((page) => page.pageId));
    const receipt = await this.withOperationFeedback(() => new ActionWaiter(registered.page).run(action, {
      ...options, signal: options.signal ?? this.#executionSignal,
    }), 'ai', registered.pageId);
    const after = new Set(this.#registry.pages().map((page) => page.pageId));
    return {
      ...receipt,
      openedPageIds: Object.freeze([...after].filter((pageId) => !before.has(pageId))),
      closedPageIds: Object.freeze([...before].filter((pageId) => !after.has(pageId))),
    };
  }

  getDialog(pageId?: number): Dialog | undefined { return this.#registry.getDialog(pageId ?? this.#targetPageId); }

  throwIfDialogOpen(pageId?: number): void {
    const dialog = this.getDialog(pageId);
    if (dialog && !dialog.handled) throw new BrowserDialogOpenError(observeDialog(dialog));
  }

  clearDialog(pageId?: number): void { this.#registry.clearDialog(pageId ?? this.#targetPageId); }

  async handleDialog(action: 'accept' | 'dismiss', promptText?: string, pageId?: number): Promise<void> {
    const registered = this.#requirePage(pageId);
    const dialog = this.#registry.getDialog(registered.pageId);
    if (!dialog) throw new Error('No open dialog found');
    try {
      if (action === 'dismiss') await dialog.dismiss();
      else await dialog.accept(promptText);
    } catch { /* Source treats a dialog handled outside automation as success. */ }
    this.#registry.clearDialog(registered.pageId);
  }

  async consumePageChanges(): Promise<PageChangeSet> {
    await this.#registry.refresh();
    return this.#registry.consumeChanges();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cancel of this.#feedbackDelays) cancel();
    this.#feedbackDelays.clear();
    this.#pageSnapshots.clear();
    this.#registry.dispose();
    this.#pagePointers.clear();
    this.#targetOrders.clear();
    this.#screenSequences.clear();
    this.#screenFrames.clear();
    for (const pageId of this.#targetHandles.keys()) this.#releaseTarget(pageId);
    this.#screenListeners.clear();
  }

  #requirePage(pageId?: number): RegisteredPage {
    this.#assertActive();
    const id = pageId ?? this.#targetPageId;
    if (id === undefined) return this.#registry.selectedPage();
    const registered = this.#registry.pageById(id);
    if (!registered) throw new Error('No page found');
    return registered;
  }

  #snapshotState(pageId: number): PageSnapshotState {
    let state = this.#pageSnapshots.get(pageId);
    if (!state) { state = { identityMap: new Map() }; this.#pageSnapshots.set(pageId, state); }
    return state;
  }

  #requireSnapshot(pageId: number): TextSnapshotResult {
    const snapshot = this.#pageSnapshots.get(pageId)?.snapshot;
    if (!snapshot) throw new Error(`No snapshot found for page ${pageId}. Use take_snapshot to capture one.`);
    return snapshot;
  }

  #interruptedReceipt(pageId: number): ActionReceipt {
    const dialog = this.#registry.getDialog(pageId);
    return { ...emptyReceipt(), domSettled: false, interrupted: true,
      ...(dialog ? { dialog: observeDialog(dialog) } : {}) };
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Browser automation session has been disposed');
  }
}

async function selectNativeOption(handle: ElementHandle<Element>, input: BrowserInputDriver, signal: AbortSignal): Promise<boolean> {
  const selectHandle = await handle.evaluateHandle((node) => {
    if (!(node instanceof HTMLOptionElement)) return null;
    const select = node.closest('select');
    if (!select || select.multiple || select.disabled || node.disabled) return null;
    if (node.parentElement instanceof HTMLOptGroupElement && node.parentElement.disabled) return null;
    return select;
  });
  const select = selectHandle.asElement() as ElementHandle<Element> | null;
  if (!select) {
    void selectHandle.dispose();
    return false;
  }

  try {
    const valueHandle = await handle.getProperty('value');
    try {
      const value = await raceAbort(valueHandle.jsonValue(), signal);
      if (typeof value !== 'string') return false;
      await input.selectValue(select, value, signal);
      return true;
    } finally {
      void valueHandle.dispose();
    }
  } finally {
    void selectHandle.dispose();
  }
}

async function selectOptionByText(
  handle: ElementHandle<Element>,
  options: readonly TextSnapshotNode[],
  value: string,
  input: BrowserInputDriver,
  signal: AbortSignal,
): Promise<void> {
  let optionFound = false;
  for (const child of options) {
    if (child.role !== 'option' || child.name !== value || !child.value) continue;
    optionFound = true;
    const childHandle = await raceAbort(child.elementHandle(), signal);
    if (!childHandle) continue;
    try {
      const valueHandle = await raceAbort(childHandle.getProperty('value'), signal);
      try {
        const actualValue = await raceAbort(valueHandle.jsonValue(), signal);
        if (typeof actualValue === 'string') await input.selectValue(handle, actualValue, signal);
      } finally {
        void valueHandle.dispose();
      }
    } finally {
      void childHandle.dispose();
    }
    break;
  }
  if (!optionFound) throw new Error(`Could not find option with text "${value}"`);
}

function observeDialog(dialog: Dialog): DialogObservation {
  return {
    type: dialog.type(),
    message: dialog.message(),
    defaultValue: dialog.defaultValue(),
    handled: dialog.handled,
  };
}

function emptyReceipt(): ActionReceipt {
  return {
    navigated: false,
    domSettled: true,
    openedPageIds: Object.freeze([]),
    closedPageIds: Object.freeze([]),
  };
}

function throwActionError(error: unknown, uid: string): never {
  const reason = error instanceof TimeoutError
    ? 'The element did not become interactive within the configured timeout.'
    : error instanceof Error ? error.message : String(error);
  throw new Error(
    `Failed to interact with the element with uid ${uid}. ${reason}`,
    { cause: error }
  );
}
