/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.7.0 McpContext, McpPage, and input
 * tools. MCP transport and response plumbing were replaced by Piskie's
 * BrowserManager-owned session and browser contracts.
 */

import {
  Locator,
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
import type { ConsoleObservation } from './page-collector.js';
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

interface ActiveSnapshot {
  readonly generation: string;
  readonly pageId: number;
  readonly navigationSequence: number;
  readonly result: TextSnapshotResult;
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
  #activeSnapshot: ActiveSnapshot | undefined;
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
        session.#invalidateSnapshot();
        if (previousPageId !== undefined && previousPageId !== pageId) {
          session.#clearPageFeedback(previousPageId);
          if (pageId !== undefined) session.#clearPageFeedback(pageId);
        }
      },
      mainFrameNavigated: (pageId) => {
        if (session.#activeSnapshot?.pageId === pageId) session.#invalidateSnapshot();
        session.#releaseTarget(pageId);
      },
      frameChanged: (registered, frame) => {
        session.#screenSequences.set(registered.pageId, (session.#screenSequences.get(registered.pageId) ?? 0) + 1);
        session.#releaseTarget(registered.pageId);
        // Main navigation is published after the registry commits its snapshot identity.
        if (frame === registered.page.mainFrame()) return;
        if (session.#registry && !registered.page.isClosed()
          && session.#registry.selectedPage().pageId === registered.pageId) {
          session.#publishScreen({ type: 'target', target: session.#screenTarget(registered) });
        }
      },
      screenChanged: (registered) => session.#publishScreen({
        type: 'target', target: registered ? session.#screenTarget(registered) : null,
      }),
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

  getScreenTarget(): BrowserScreenTarget {
    return this.#screenTarget(this.#registry.selectedPage());
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
    let pageId: number;
    try { pageId = this.#registry.selectedPage().pageId; } catch { return null; }
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
    if (event.type === 'target') {
      const pointer = event.target ? this.#pagePointers.get(event.target.identity.pageId) : undefined;
      if (event.target && pointer && !sameScreenPage(pointer.page, event.target.identity)) {
        const activity = { page: event.target.identity, seq: ++this.#screenSequence, timestamp: Date.now(),
          kind: 'navigation' as const, actor: 'ai' as const, pending: false };
        this.#pagePointers.set(event.target.identity.pageId, { ...pointer, activity,
          positionTarget: pointer.target ?? pointer.positionTarget, target: undefined, revision: ++this.#revision });
      }
    } else {
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
      if (this.#registry.selectedPage().pageId !== token.page.pageId) {
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
    if (this.#disposed || !sameScreenPage(this.getScreenTarget().identity, identity)) return;
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

  /** Shared operation boundary also observes reliable script focus/scroll outcomes and read activity. */
  async withOperationFeedback<T>(action: () => Promise<T> | T, actor: ScreenInputActor = 'ai'): Promise<T> {
    if (this.#operationDepth > 0) return action();
    const page = this.getSelectedPage();
    const token = this.#beginOperation(page, 'operation', actor);
    this.#operationDepth++;
    // Start sampling before dispatch, without making the business promise await feedback or drawing.
    const sample = this.#screenListeners.size && !this.#registry.getDialog()
      ? PageOperationFeedback.capture(page).catch(() => null) : Promise.resolve(null);
    try { return await action(); }
    finally {
      this.#operationDepth--;
      if (token) {
        this.#finishOperation(token);
        void sample.then(async (watch) => {
          if (!watch) return;
          try {
            if (this.#disposed || !sameScreenPage(this.#identityFor(page), token.page) || this.#registry.getDialog()) return;
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

  getSelectedPage(): Page {
    return this.#registry.selectedPage().page;
  }

  getSelectedPageId(): number {
    return this.#registry.selectedPage().pageId;
  }

  getSelectedPageIndex(): number {
    return this.#registry.selectedPageIndex();
  }

  getPageByIndex(pageIndex: number): Page {
    return this.#registry.pageByIndex(pageIndex).page;
  }

  async listPages(): Promise<readonly RegisteredPage[]> {
    return this.#registry.refresh();
  }

  async selectPageByIndex(pageIndex: number): Promise<Page> {
    await this.#registry.refresh();
    return this.#registry.selectByIndex(pageIndex).page;
  }

  async newPage(url?: string, timeoutMs?: number): Promise<Page> {
    const registered = await this.#registry.newPage();
    if (url !== undefined) {
      const receipt = await this.waitForAction(
        () => registered.page.goto(url, { timeout: timeoutMs }),
        { navigationTimeoutMs: timeoutMs }
      );
      this.#throwIfUnhandledDialog(receipt);
    }
    return registered.page;
  }

  async closePageByIndex(pageIndex: number): Promise<void> {
    await this.#registry.refresh();
    await this.#registry.closeByIndex(pageIndex);
  }

  async takeSnapshot(verbose = false): Promise<TextSnapshotResult> {
    this.#assertActive();
    this.throwIfDialogOpen();
    const selected = this.#registry.selectedPage();
    const result = await createTextSnapshot(selected.page, verbose);
    const current = this.#registry.pageById(selected.pageId);
    if (
      !current ||
      current.pageId !== this.#registry.selectedPage().pageId ||
      current.navigationSequence !== selected.navigationSequence
    ) {
      throw new Error('Page changed while the accessibility snapshot was being created.');
    }
    this.#activeSnapshot = {
      generation: this.generation,
      pageId: selected.pageId,
      navigationSequence: selected.navigationSequence,
      result,
    };
    return result;
  }

  getActiveSnapshot(): TextSnapshotResult | undefined {
    return this.#activeSnapshot?.result;
  }

  getAXNodeByUid(uid: string): TextSnapshotNode | undefined {
    return this.#requireActiveSnapshot().idToNode.get(uid);
  }

  async getElementByUid(uid: string): Promise<ElementHandle<Element>> {
    return resolveSnapshotElement(this.#requireActiveSnapshot(), uid);
  }

  async clickByUid(uid: string, clickCount: 1 | 2): Promise<ActionReceipt> {
    this.throwIfDialogOpen();
    const handle = await this.getElementByUid(uid);
    try {
      const node = this.getAXNodeByUid(uid);
      let receipt: ActionReceipt;
      try {
        receipt = await this.waitForAction(async () => {
          if (clickCount === 1 && node?.role === 'option' && await selectNativeOption(handle, this.input)) return;
          await handle.asLocator().click({ count: clickCount });
        });
      } catch (error) {
        this.throwIfDialogOpen();
        throwActionError(error, uid);
      }
      this.#throwIfUnhandledDialog(receipt);
      return receipt;
    } finally {
      // Both the previous vendored handler and Puppeteer's `using` hook release
      // remote handles without waiting on Runtime.releaseObject.
      void handle.dispose();
    }
  }

  async hoverByUid(uid: string): Promise<ActionReceipt> {
    this.throwIfDialogOpen();
    const handle = await this.getElementByUid(uid);
    try {
      let receipt: ActionReceipt;
      try {
        receipt = await this.waitForAction(() => handle.asLocator().hover());
      } catch (error) {
        this.throwIfDialogOpen();
        throwActionError(error, uid);
      }
      this.#throwIfUnhandledDialog(receipt);
      return receipt;
    } finally {
      void handle.dispose();
    }
  }

  async dragByUids(fromUid: string, toUid: string): Promise<ActionReceipt> {
    this.throwIfDialogOpen();
    const fromHandle = await this.getElementByUid(fromUid);
    let toHandle: ElementHandle<Element> | undefined;
    try {
      toHandle = await this.getElementByUid(toUid);
      const receipt = await this.waitForAction(async () => {
        await fromHandle.drag(toHandle!);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await toHandle!.drop(fromHandle);
      });
      this.#throwIfUnhandledDialog(receipt);
      return receipt;
    } finally {
      void fromHandle.dispose();
      void toHandle?.dispose();
    }
  }

  async uploadFileByUid(uid: string, filePath: string): Promise<void> {
    this.throwIfDialogOpen();
    const handle = await this.getElementByUid(uid);
    try {
      await this.input.upload(this.getSelectedPage(), handle, filePath);
    } finally {
      void handle.dispose();
    }
  }

  async fillByUid(uid: string, value: string): Promise<ActionReceipt> {
    this.throwIfDialogOpen();
    let receipt: ActionReceipt;
    try {
      receipt = await this.waitForAction(() => this.#fillElement(uid, value));
    } catch (error) {
      this.throwIfDialogOpen();
      throw error;
    }
    this.#throwIfUnhandledDialog(receipt);
    return receipt;
  }

  async fillFormByUids(
    elements: readonly Readonly<{ uid: string; value: string }>[]
  ): Promise<ActionReceipt> {
    let receipt = emptyReceipt();
    for (const element of elements) {
      receipt = await this.fillByUid(element.uid, element.value);
    }
    return receipt;
  }

  async typeText(text: string): Promise<ActionReceipt> {
    this.throwIfDialogOpen();
    const page = this.getSelectedPage();
    let receipt: ActionReceipt;
    try {
      receipt = await this.waitForAction(() => this.input.typeText(page, text));
    } catch (error) {
      this.throwIfDialogOpen();
      throw error;
    }
    this.#throwIfUnhandledDialog(receipt);
    return receipt;
  }

  async pressKey(keyInput: string): Promise<ActionReceipt> {
    this.throwIfDialogOpen();
    const page = this.getSelectedPage();
    let receipt: ActionReceipt;
    try {
      receipt = await this.waitForAction(() => this.input.press(page, keyInput));
    } catch (error) {
      this.throwIfDialogOpen();
      throw error;
    }
    this.#throwIfUnhandledDialog(receipt);
    return receipt;
  }

  async waitForTextOnPage(text: readonly string[], timeoutMs?: number): Promise<void> {
    this.throwIfDialogOpen();
    const frames = this.getSelectedPage().frames();
    let locator = Locator.race(
      frames.flatMap((frame) => text.flatMap((value) => [
        frame.locator(`aria/${value}`),
        frame.locator(`text/${value}`),
      ])),
    );
    if (timeoutMs) locator = locator.setTimeout(timeoutMs);
    await locator.wait();
  }

  getConsoleData(includePreservedMessages = false): readonly ConsoleObservation[] {
    return this.#registry.getConsoleData(includePreservedMessages);
  }

  getConsoleMessageById(messageId: number): ConsoleObservation {
    return this.#registry.getConsoleMessageById(messageId);
  }

  getConsoleMessageId(message: ConsoleObservation): number {
    return this.#registry.getConsoleMessageId(message);
  }

  getNetworkRequests(includePreservedRequests = false): readonly HTTPRequest[] {
    return this.#registry.getNetworkRequests(includePreservedRequests);
  }

  getNetworkRequestById(requestId: number): HTTPRequest {
    return this.#registry.getNetworkRequestById(requestId);
  }

  getNetworkRequestId(request: HTTPRequest): number {
    return this.#registry.getNetworkRequestId(request);
  }

  async waitForAction(
    action: () => Promise<unknown>,
    options: ActionWaitOptions = {}
  ): Promise<ActionReceipt> {
    this.#assertActive();
    const before = new Set((await this.#registry.refresh()).map((page) => page.pageId));
    const receipt = await this.withOperationFeedback(() => new ActionWaiter(this.getSelectedPage()).run(action, options));
    const after = new Set((await this.#registry.refresh()).map((page) => page.pageId));
    return {
      ...receipt,
      openedPageIds: Object.freeze([...after].filter((pageId) => !before.has(pageId))),
      closedPageIds: Object.freeze([...before].filter((pageId) => !after.has(pageId))),
    };
  }

  throwIfDialogOpen(): void {
    const dialog = this.#registry.getDialog();
    if (dialog && !dialog.handled) throw new BrowserDialogOpenError(observeDialog(dialog));
  }

  clearDialog(): void {
    this.#registry.clearDialog();
  }

  async handleDialog(action: 'accept' | 'dismiss', promptText?: string): Promise<void> {
    const pageId = this.#registry.selectedPage().pageId;
    const dialog = this.#registry.getDialog(pageId);
    if (!dialog) throw new Error('No open dialog found');

    try {
      if (action === 'dismiss') await dialog.dismiss();
      else await dialog.accept(promptText);
    } catch {
      // chrome-devtools-mcp treats a dialog handled outside automation as success.
    }
    this.#registry.clearDialog(pageId);
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
    this.#invalidateSnapshot();
    this.#registry.dispose();
    this.#pagePointers.clear();
    this.#targetOrders.clear();
    this.#screenSequences.clear();
    this.#screenFrames.clear();
    for (const pageId of this.#targetHandles.keys()) this.#releaseTarget(pageId);
    this.#screenListeners.clear();
  }

  async #fillElement(uid: string, value: string): Promise<void> {
    const handle = await this.getElementByUid(uid);
    try {
      const node = this.getAXNodeByUid(uid);
      try {
        const options = node?.role === 'combobox' ? optionDescendants(node) : [];
        if (options.length > 0) {
          await selectOptionByText(handle, options, value, this.input);
          return;
        }

        const fillTimeout = this.getSelectedPage().getDefaultTimeout() + value.length * 10;
        await this.input.fill(handle, value, fillTimeout, 'boolean-text');
      } catch (error) {
        throwActionError(error, uid);
      }
    } finally {
      void handle.dispose();
    }
  }

  #requireActiveSnapshot(): TextSnapshotResult {
    this.#assertActive();
    const active = this.#activeSnapshot;
    if (!active) throw new Error('No snapshot found. Use take_snapshot to capture one.');
    const selected = this.#registry.selectedPage();
    if (
      active.generation !== this.generation ||
      active.pageId !== selected.pageId ||
      active.navigationSequence !== selected.navigationSequence
    ) {
      this.#invalidateSnapshot();
      throw new Error(
        'This uid is coming from a stale snapshot. Call take_snapshot to get a fresh snapshot.'
      );
    }
    return active.result;
  }

  #throwIfUnhandledDialog(receipt: ActionReceipt): void {
    if (receipt.dialog && !receipt.dialog.handled) {
      throw new BrowserDialogOpenError(receipt.dialog);
    }
  }

  #invalidateSnapshot(): void {
    this.#activeSnapshot = undefined;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Browser automation session has been disposed');
  }
}

async function selectNativeOption(handle: ElementHandle<Element>, input: BrowserInputDriver): Promise<boolean> {
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
      const value = await valueHandle.jsonValue();
      if (typeof value !== 'string') return false;
      await input.selectValue(select, value);
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
): Promise<void> {
  let optionFound = false;
  for (const child of options) {
    if (child.role !== 'option' || child.name !== value || !child.value) continue;
    optionFound = true;
    const childHandle = await child.elementHandle();
    if (!childHandle) continue;
    try {
      const valueHandle = await childHandle.getProperty('value');
      try {
        const actualValue = await valueHandle.jsonValue();
        if (actualValue) await input.selectValue(handle, actualValue.toString());
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

function optionDescendants(node: TextSnapshotNode): TextSnapshotNode[] {
  const options: TextSnapshotNode[] = [];
  const pending = [...node.children];
  while (pending.length > 0) {
    const child = pending.shift()!;
    if (child.role === 'option') options.push(child);
    pending.push(...child.children);
  }
  return options;
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
  throw new Error(
    `Failed to interact with the element with uid ${uid}. The element did not become interactive within the configured timeout.`,
    { cause: error }
  );
}
