import type { ElementHandle, KeyInput, Page } from 'puppeteer-core';
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

  async fill(handle: ElementHandle<Element>, value: string, timeoutMs: number, toggles: 'boolean-text' | 'reject'): Promise<void> {
    const isToggle = await handle.evaluate(isToggleControl);
    if (isToggle && toggles === 'reject') throw new Error('Browser Skill fill requires a text input, textarea or contenteditable element; toggles are not supported.');
    if (isToggle && value !== 'true' && value !== 'false') {
      throw new Error(`Checkboxes, radio boxes and toggles require "true" or "false" value, but ${value} was used`);
    }
    const isSelect = !isToggle && await handle.evaluate(isSelectControl);
    await this.element(handle, isSelect ? 'select' : 'input', () =>
      handle.asLocator().setTimeout(timeoutMs).fill(isToggle ? value === 'true' : value));
  }

  selectValue(handle: ElementHandle<Element>, value: string): Promise<void> {
    return this.element(handle, 'select', () => handle.asLocator().fill(value));
  }

  select(handle: ElementHandle<Element>, value: string): Promise<string[]> {
    return this.element(handle, 'select', () => handle.select(value));
  }

  upload(page: Page, handle: ElementHandle<Element>, filePath: string, timeoutMs?: number): Promise<void> {
    return this.element(handle, 'upload', () => uploadFileThroughElement(page, handle, filePath, timeoutMs));
  }

  typeText(page: Page, text: string): Promise<void> {
    return this.keyboard(page, 'input', () => typeKeyboardText(page.keyboard, text));
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
function isSelectControl(element: Element): boolean { return element instanceof HTMLSelectElement; }

export async function uploadFileThroughElement(page: Page, handle: ElementHandle<Element>, filePath: string, clickTimeoutMs?: number): Promise<void> {
  try {
    await (handle as ElementHandle<HTMLInputElement>).uploadFile(filePath);
  } catch {
    try {
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 3_000 }),
        clickTimeoutMs === undefined ? handle.asLocator().click() : handle.asLocator().setTimeout(clickTimeoutMs).click(),
      ]);
      await fileChooser.accept([filePath]);
    } catch {
      throw new Error('Failed to upload file. The element could not accept the file directly, '
        + 'and clicking it did not trigger a file chooser.');
    }
  }
}
