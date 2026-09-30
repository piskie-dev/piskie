const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent'] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? dom.window : dom.window[name],
    });
  }
  return dom;
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetShortcutRegistry } from '@/shortcuts';
import { MenuHarness, type MenuHarnessProps } from './menuHarness';

let root: Root;
let container: HTMLDivElement;
const select = vi.fn();
const objectClick = vi.fn();
const remoteContextMenu = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  const open = new WeakSet<Element>();
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':popover-open' ? open.has(this) : matches.call(this, selector);
  });
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value(this: HTMLElement) { open.add(this); },
  });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value(this: HTMLElement) {
      open.delete(this);
      const toggle = new Event('toggle');
      Object.defineProperty(toggle, 'newState', { value: 'closed' });
      this.dispatchEvent(toggle);
    },
  });
  select.mockReset();
  objectClick.mockReset();
  remoteContextMenu.mockReset();
  resetShortcutRegistry();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.getSelection()?.removeAllRanges();
  resetShortcutRegistry();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => testDOM.window.close());

async function render(props: Partial<MenuHarnessProps> = {}) {
  await act(async () => root.render(createElement(MenuHarness, {
    onSelect: select,
    onObjectClick: objectClick,
    onRemoteContextMenu: remoteContextMenu,
    ...props,
  })));
}

function element(selector: string): HTMLElement {
  const result = container.querySelector<HTMLElement>(selector);
  expect(result, selector).not.toBeNull();
  return result!;
}

async function dispatch(target: EventTarget, type: string, init: MouseEventInit = {}): Promise<MouseEvent> {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

async function rightClick(selector = '#alpha-label') {
  return dispatch(element(selector), 'contextmenu', { button: 2, clientX: 80, clientY: 60 });
}

function action(text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'))
    .find((button) => button.textContent?.includes(text));
  expect(result, text).toBeDefined();
  return result!;
}

function menu(): HTMLElement | null {
  return container.querySelector('[role="menu"]');
}

describe('shared console menus', () => {
  it('dispatches the same action from both entry points without clicking the object', async () => {
    await render();
    await dispatch(element('button[aria-label="alpha actions"]'), 'click');
    const buttonLabels = Array.from(menu()!.querySelectorAll('[role^="menuitem"]'), (item) => item.textContent);
    await dispatch(action('Open object'), 'click');
    expect(select).toHaveBeenLastCalledWith('alpha', 'open');
    expect(menu()).toBeNull();

    const event = await rightClick();
    expect(event.defaultPrevented).toBe(true);
    expect(Array.from(menu()!.querySelectorAll('[role^="menuitem"]'), (item) => item.textContent)).toEqual(buttonLabels);
    await dispatch(action('Open object'), 'click');
    expect(select.mock.calls).toEqual([['alpha', 'open'], ['alpha', 'open']]);
    expect(objectClick).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it.each(['button', 'context'] as const)('shows groups, disabled reasons and checked choices through %s', async (entry) => {
    await render();
    if (entry === 'button') await dispatch(element('button[aria-label="alpha actions"]'), 'click');
    else await rightClick();
    expect(menu()!.querySelectorAll('[role="separator"]')).toHaveLength(2);
    const disabled = action('Remove object');
    expect(disabled.disabled).toBe(true);
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(disabled.getAttribute('aria-describedby')!)?.textContent).toBe('Object is busy');
    await dispatch(disabled, 'click');
    expect(select).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    expect(action('Compact view').getAttribute('role')).toBe('menuitemradio');
    expect(action('Compact view').getAttribute('aria-checked')).toBe('true');
    expect(action('Comfortable view').getAttribute('aria-checked')).toBe('false');
    await dispatch(action('Comfortable view'), 'click');
    expect(select).toHaveBeenCalledWith('alpha', 'comfortable');
    expect(menu()).toBeNull();
  });

  it.each(['button', 'context'] as const)('dispatches sorting leaves and closes the entire %s menu', async (entry) => {
    await render();
    if (entry === 'button') await dispatch(element('button[aria-label="alpha actions"]'), 'click');
    else await rightClick();
    await dispatch(action('Sort objects'), 'click');
    expect(select).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[role="menu"]')).toHaveLength(2);
    expect(action('By name').getAttribute('aria-checked')).toBe('true');
    await dispatch(action('By recent activity'), 'click');
    expect(select).toHaveBeenCalledWith('alpha', 'recent');
    expect(objectClick).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it('uses the closest registered object without selecting it', async () => {
    await render();
    await rightClick('#beta-child');
    expect(menu()!.getAttribute('aria-label')).toBe('beta actions');
    expect(container.querySelectorAll('[role="menu"]')).toHaveLength(1);
    await dispatch(action('Open object'), 'click');
    expect(select).toHaveBeenCalledWith('beta', 'open');
    expect(objectClick).not.toHaveBeenCalled();
  });

  it('leaves editors, selected text, unregistered objects and non-mouse context events alone', async () => {
    await render();
    for (const selector of ['#editor', '#draft', '#editable-title', '#unregistered']) {
      expect((await rightClick(selector)).defaultPrevented).toBe(false);
      expect(menu()).toBeNull();
    }
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element('#body-selection'));
    selection.addRange(range);
    expect((await rightClick('#body-selection')).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    // A text selection elsewhere does not suppress an object's menu.
    expect((await rightClick('#gamma-label')).defaultPrevented).toBe(true);
    await dispatch(action('Open object'), 'click');
    expect((await dispatch(element('#alpha-label'), 'contextmenu', { button: 0 })).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    await rightClick('#remote');
    expect(remoteContextMenu).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it.each([{ nestedItems: [] }, { nestedDisabled: true }])('does not fall back from an unavailable nested object to its parent: %j', async (props) => {
    await render(props);
    expect((await rightClick('#beta-child')).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it('respects a child context handler that already consumed the event', async () => {
    await render();
    const target = element('#alpha-label');
    target.addEventListener('contextmenu', (event) => event.preventDefault());
    await rightClick();
    expect(menu()).toBeNull();
  });

  it.each(['button', 'context'] as const)('closes the %s menu on target scrolling and dragging, while allowing menu scrolling', async (entry) => {
    await render();
    const open = async () => {
      if (entry === 'button') await dispatch(element('button[aria-label="alpha actions"]'), 'click');
      else await rightClick();
    };
    await open();
    await act(async () => { menu()!.dispatchEvent(new Event('scroll')); });
    await act(async () => { element('#other-scroller').dispatchEvent(new Event('scroll')); });
    expect(menu()).not.toBeNull();
    await act(async () => { element('#scroller').dispatchEvent(new Event('scroll')); });
    expect(menu()).toBeNull();
    await open();
    await act(async () => { element('#alpha').dispatchEvent(new Event('dragstart', { bubbles: true })); });
    expect(menu()).toBeNull();
  });

  it('waits for the opening right button to be released before showing a native popover', async () => {
    await render();
    const event = await dispatch(element('#alpha-label'), 'contextmenu', { button: 2, buttons: 2, clientX: 80, clientY: 60 });
    expect(event.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    await dispatch(document, 'pointerup', { button: 0 });
    expect(menu()).toBeNull();
    await dispatch(document, 'pointerup', { button: 2 });
    expect(menu()!.getAttribute('aria-label')).toBe('alpha actions');
    expect(objectClick).not.toHaveBeenCalled();
  });

  it('cancels an opening gesture when its pointer is canceled', async () => {
    await render();
    await dispatch(element('#alpha-label'), 'contextmenu', { button: 2, buttons: 2 });
    await dispatch(document, 'pointercancel', { button: 2 });
    await dispatch(document, 'pointerup', { button: 2 });
    expect(menu()).toBeNull();
  });

  it('reflects native light-dismiss and can reopen afterwards', async () => {
    await render();
    await rightClick();
    const popover = menu()!.closest<HTMLElement>('[popover]')!;
    await act(async () => popover.hidePopover());
    expect(menu()).toBeNull();
    await rightClick();
    expect(menu()).not.toBeNull();
  });

  it('updates open menus from current descriptors and closes when actions disappear', async () => {
    await render();
    await rightClick();
    await render({ items: [{ key: 'open', label: 'Open object', disabled: true }] });
    expect(action('Open object').disabled).toBe(true);
    await dispatch(action('Open object'), 'click');
    expect(select).not.toHaveBeenCalled();
    await render({ items: [] });
    expect(menu()).toBeNull();
  });
});
