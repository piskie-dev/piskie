import type { JSDOM } from 'jsdom';
import { act } from 'react';
import { expect, vi } from 'vitest';

export function installMenuDom(dom: JSDOM): void {
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'MutationObserver'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const open = new WeakSet<Element>();
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':popover-open' ? open.has(this) : matches.call(this, selector);
  });
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value(this: HTMLElement) { open.add(this); } });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value(this: HTMLElement) {
    open.delete(this);
    const event = new Event('toggle');
    Object.defineProperty(event, 'newState', { value: 'closed' });
    this.dispatchEvent(event);
  } });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
}

export async function rightClick(element: Element): Promise<MouseEvent> {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 60 });
  await act(async () => { element.dispatchEvent(event); });
  return event;
}

export function menuLabels(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll('[role="menuitem"]'), (item) => item.textContent ?? '');
}

export async function selectMenuItem(container: ParentNode, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((item) => item.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
