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
  type KeyInput,
  type Page,
} from 'puppeteer-core';
import { ActionWaiter, type ActionReceipt, type ActionWaitOptions, type DialogObservation } from './action-waiter.js';
import { parseKeyCombination } from './keyboard.js';
import type { ConsoleObservation } from './page-collector.js';
import { PageRegistry, type PageChangeSet, type RegisteredPage } from './page-registry.js';
import {
  createTextSnapshot,
  resolveSnapshotElement,
  type TextSnapshotNode,
  type TextSnapshotResult,
} from './text-snapshot.js';

let nextSessionGeneration = 1;

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

  private constructor(browser: Browser) {
    this.browser = browser;
    this.generation = `connection-${nextSessionGeneration++}`;
  }

  static async create(browser: Browser): Promise<BrowserAutomationSession> {
    const session = new BrowserAutomationSession(browser);
    session.#registry = await PageRegistry.create(browser, {
      selectedPageChanged: () => session.#invalidateSnapshot(),
      mainFrameNavigated: (pageId) => {
        if (session.#activeSnapshot?.pageId === pageId) session.#invalidateSnapshot();
      },
    });
    return session;
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
          if (clickCount === 1 && node?.role === 'option' && await selectNativeOption(handle)) return;
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
    const handle = await this.getElementByUid(uid) as ElementHandle<HTMLInputElement>;
    try {
      try {
        await handle.uploadFile(filePath);
      } catch {
        try {
          const [fileChooser] = await Promise.all([
            this.getSelectedPage().waitForFileChooser({ timeout: 3_000 }),
            handle.asLocator().click(),
          ]);
          await fileChooser.accept([filePath]);
        } catch {
          throw new Error(
            'Failed to upload file. The element could not accept the file directly, '
            + 'and clicking it did not trigger a file chooser.',
          );
        }
      }
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

  async pressKey(keyInput: string): Promise<ActionReceipt> {
    this.throwIfDialogOpen();
    const [key, ...modifiers] = parseKeyCombination(keyInput);
    const page = this.getSelectedPage();
    let receipt: ActionReceipt;
    try {
      receipt = await this.waitForAction(async () => {
        const heldModifiers: KeyInput[] = [];
        try {
          for (const modifier of modifiers) {
            await page.keyboard.down(modifier);
            heldModifiers.push(modifier);
          }
          await page.keyboard.press(key);
        } finally {
          for (let index = heldModifiers.length - 1; index >= 0; index -= 1) {
            await page.keyboard.up(heldModifiers[index]);
          }
        }
      });
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
    const receipt = await new ActionWaiter(this.getSelectedPage()).run(action, options);
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
    this.#invalidateSnapshot();
    this.#registry.dispose();
  }

  async #fillElement(uid: string, value: string): Promise<void> {
    const handle = await this.getElementByUid(uid);
    try {
      const node = this.getAXNodeByUid(uid);
      try {
        const options = node?.role === 'combobox' ? optionDescendants(node) : [];
        if (options.length > 0) {
          await selectOptionByText(handle, options, value);
          return;
        }

        const isToggle = await handle.evaluate((element) => {
          if (element instanceof HTMLInputElement) {
            return element.type === 'checkbox' || element.type === 'radio';
          }
          const role = element.getAttribute('role');
          return role === 'checkbox' || role === 'radio' || role === 'switch';
        });
        if (isToggle) {
          if (!['true', 'false'].includes(value)) {
            throw new Error(
              `Checkboxes, radio boxes and toggles require "true" or "false" value, but ${value} was used`
            );
          }
          await handle.asLocator().fill(value === 'true');
          return;
        }

        const fillTimeout = this.getSelectedPage().getDefaultTimeout() + value.length * 10;
        await handle.asLocator().setTimeout(fillTimeout).fill(value);
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

async function selectNativeOption(handle: ElementHandle<Element>): Promise<boolean> {
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
      await select.asLocator().fill(value);
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
  value: string
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
        if (actualValue) await handle.asLocator().fill(actualValue.toString());
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
