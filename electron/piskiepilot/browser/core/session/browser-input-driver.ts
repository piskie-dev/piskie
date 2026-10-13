/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Input actions adapt chrome-devtools-mcp@1.10.1 src/tools/input.ts to the
 * host's shared input and pointer feedback owner. SDK value rules stay local.
 */

import type { ElementHandle, KeyInput, Page } from 'puppeteer-core';
import { raceAbort } from '@electron/utils/abort.js';
import type { ScreenInputActor, ScreenOperationKind, ScreenPageIdentity } from '@shared/types/stream.js';
import { parseKeyCombination, typeKeyboardText } from './keyboard.js';

export interface OperationToken {
  readonly page: ScreenPageIdentity;
  readonly seq: number;
  readonly timestamp: number;
  readonly kind: ScreenOperationKind;
  readonly actor: ScreenInputActor;
}
export interface OperationFeedbackSink {
  begin(page: Page, kind: ScreenOperationKind, actor?: ScreenInputActor): OperationToken | null;
  finish(token: OperationToken): void;
  element(token: OperationToken, handle: ElementHandle<Element>): void;
  focus(token: OperationToken, page: Page): void;
}

/** UID and locator execution share this input boundary; feedback never changes input semantics. */
export class BrowserInputDriver {
  constructor(private readonly feedback: OperationFeedbackSink) {}

  click(handle: ElementHandle<Element>, count: 1 | 2, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    signal?.throwIfAborted();
    const locator = timeoutMs === undefined ? handle.asLocator() : handle.asLocator().setTimeout(timeoutMs);
    return locator.click({ count, signal });
  }

  hover(handle: ElementHandle<Element>, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    signal?.throwIfAborted();
    const locator = timeoutMs === undefined ? handle.asLocator() : handle.asLocator().setTimeout(timeoutMs);
    return locator.hover({ signal });
  }

  async drag(from: ElementHandle<Element>, to: ElementHandle<Element>): Promise<void> {
    await from.drag(to);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await to.drop(from);
  }

  async fill(handle: ElementHandle<Element>, value: string, timeoutMs: number, toggles: 'boolean-text' | 'reject', signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const isToggle = await raceAbort(handle.evaluate(toggles === 'boolean-text' ? isSnapshotToggleControl : isToggleControl), signal);
    if (isToggle && toggles === 'reject') throw new Error('Browser Skill fill requires a text input, textarea or contenteditable element; toggles are not supported.');
    if (isToggle && value !== 'true' && value !== 'false') {
      throw new Error(`Checkboxes, radio boxes and toggles require "true" or "false" value, but ${value} was used`);
    }
    const isSelect = !isToggle && await raceAbort(handle.evaluate(isSelectControl), signal);
    signal?.throwIfAborted();
    await this.element(handle, isSelect ? 'select' : 'input', () =>
      (isToggle ? handle.asLocator() : handle.asLocator().setTimeout(timeoutMs)).fill(isToggle ? value === 'true' : value, { signal }));
  }

  selectValue(handle: ElementHandle<Element>, value: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return this.element(handle, 'select', () => handle.asLocator().fill(value, { signal }));
  }

  select(handle: ElementHandle<Element>, value: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    return this.element(handle, 'select', () => raceAbort(handle.select(value), signal));
  }

  upload(page: Page, handle: ElementHandle<Element>, filePaths: string | readonly string[], timeoutMs?: number): Promise<void> {
    return this.element(handle, 'upload', () => uploadFileThroughElement(page, handle, filePaths, timeoutMs));
  }

  typeText(page: Page, text: string, submitKey?: string): Promise<void> {
    return this.keyboard(page, 'input', async () => {
      await typeKeyboardText(page.keyboard, text);
      if (submitKey) await page.keyboard.press(submitKey as KeyInput);
    });
  }

  press(page: Page, input: string): Promise<void> {
    const [key, ...modifiers] = parseKeyCombination(input);
    return this.keyboard(page, 'key', async () => {
      const held: KeyInput[] = [];
      try {
        for (const modifier of modifiers) { await page.keyboard.down(modifier); held.push(modifier); }
        await page.keyboard.press(key);
      } finally {
        for (let index = held.length - 1; index >= 0; index--) await page.keyboard.up(held[index]);
      }
    });
  }

  async element<T>(handle: ElementHandle<Element>, kind: 'input' | 'select' | 'upload', action: () => Promise<T>): Promise<T> {
    const token = this.feedback.begin(handle.frame.page(), kind);
    try {
      const value = await action();
      if (token) this.feedback.element(token, handle);
      return value;
    } finally { if (token) this.feedback.finish(token); }
  }

  async keyboard<T>(page: Page, kind: 'input' | 'key', action: () => Promise<T>): Promise<T> {
    const token = this.feedback.begin(page, kind);
    try {
      const value = await action();
      if (token) this.feedback.focus(token, page);
      return value;
    } finally { if (token) this.feedback.finish(token); }
  }
}

export function isToggleControl(element: Element): boolean {
  if (element instanceof HTMLInputElement) return element.type === 'checkbox' || element.type === 'radio';
  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)) return false;
  return ['checkbox', 'radio', 'switch'].includes(element.getAttribute('role') ?? '');
}
function isSnapshotToggleControl(element: Element): boolean {
  if (element instanceof HTMLInputElement) return element.type === 'checkbox' || element.type === 'radio';
  const role = element.getAttribute('role');
  return role === 'checkbox' || role === 'radio' || role === 'switch';
}
function isSelectControl(element: Element): boolean { return element instanceof HTMLSelectElement; }

export async function uploadFileThroughElement(page: Page, handle: ElementHandle<Element>, filePaths: string | readonly string[], clickTimeoutMs?: number): Promise<void> {
  const paths = typeof filePaths === 'string' ? [filePaths] : [...filePaths];
  try {
    await (handle as ElementHandle<HTMLInputElement>).uploadFile(...paths);
  } catch {
    try {
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 3_000 }),
        clickTimeoutMs === undefined ? handle.asLocator().click() : handle.asLocator().setTimeout(clickTimeoutMs).click(),
      ]);
      await fileChooser.accept(paths);
    } catch {
      throw new Error('Failed to upload file. The element could not accept the file directly, '
        + 'and clicking it did not trigger a file chooser.');
    }
  }
}
