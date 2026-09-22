import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountShortcutListener, shortcutEventFromKeyboardEvent } from '../dom';
import { createShortcutRouter } from '../router';
import type { ShortcutBinding } from '../types';

const openWindows: JSDOM[] = [];

afterEach(() => {
  for (const dom of openWindows.splice(0)) dom.window.close();
});

function createDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><input><div contenteditable="true"><span></span></div></body></html>');
  openWindows.push(dom);
  return dom;
}

function binding(
  id: string,
  combo: string,
  execute: () => void,
  options: { readonly allowInEditable?: boolean; readonly repeat?: boolean } = {},
): ShortcutBinding {
  return {
    id,
    commandId: `command.${id}`,
    combo,
    enabled: () => true,
    allowInEditable: options.allowInEditable,
    repeat: options.repeat,
    handling: 'execute',
    defaultBehavior: 'prevent',
    execute,
  };
}

describe('shortcut DOM adapter', () => {
  it('translates the complete KeyboardEvent state and editable ancestry', () => {
    const dom = createDom();
    const target = dom.window.document.querySelector('span')!;
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'X',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      repeat: true,
      isComposing: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'target', { configurable: true, value: target });
    event.preventDefault();

    expect(shortcutEventFromKeyboardEvent(event)).toMatchObject({
      key: 'X',
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: true,
      defaultPrevented: true,
      isComposing: true,
      editableTarget: true,
      repeat: true,
    });
  });

  it('mounts one physical listener and reference-counts callers', () => {
    const dom = createDom();
    const router = createShortcutRouter();
    const execute = vi.fn();
    router.registerScope({
      id: 'page',
      layer: 'page',
      blocksLowerLayers: 'none',
      bindings: [binding('page', 'escape', execute)],
    });
    const add = vi.spyOn(dom.window, 'addEventListener');
    const remove = vi.spyOn(dom.window, 'removeEventListener');

    const disposeFirst = mountShortcutListener(dom.window as unknown as Window, router);
    const disposeSecond = mountShortcutListener(dom.window as unknown as Window, router);
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    expect(execute).toHaveBeenCalledOnce();

    disposeFirst();
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);

    disposeSecond();
    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
  });

  it('preserves ignored defaults and prevents an eligible editable binding', () => {
    const dom = createDom();
    const router = createShortcutRouter();
    const execute = vi.fn();
    router.registerScope({
      id: 'page',
      layer: 'page',
      blocksLowerLayers: 'none',
      bindings: [
        binding('editable', 'ctrl+b', execute, { allowInEditable: true }),
        binding('repeat', 'ctrl+r', execute, { allowInEditable: true, repeat: true }),
      ],
    });
    const dispose = mountShortcutListener(dom.window as unknown as Window, router);
    const input = dom.window.document.querySelector('input')!;

    const editable = new dom.window.KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(editable);
    expect(editable.defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledOnce();

    const composing = new dom.window.KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    input.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);

    const alreadyPrevented = new dom.window.KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    alreadyPrevented.preventDefault();
    input.dispatchEvent(alreadyPrevented);

    const repeated = new dom.window.KeyboardEvent('keydown', {
      key: 'r',
      ctrlKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(repeated);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(repeated.defaultPrevented).toBe(true);
    dispose();
  });

  it('leaves Escape to an unmanaged native overlay during migration', () => {
    const dom = createDom();
    const dialog = dom.window.document.createElement('dialog');
    dialog.setAttribute('open', '');
    dom.window.document.body.append(dialog);
    const router = createShortcutRouter();
    const page = vi.fn();
    router.registerScope({
      id: 'page',
      layer: 'page',
      blocksLowerLayers: 'none',
      bindings: [binding('page', 'escape', page)],
    });
    const dispose = mountShortcutListener(dom.window as unknown as Window, router);
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    dialog.dispatchEvent(event);
    expect(page).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  it('routes Escape through a managed overlay even when a dialog is open', () => {
    const dom = createDom();
    const dialog = dom.window.document.createElement('dialog');
    dialog.setAttribute('open', '');
    dom.window.document.body.append(dialog);
    const router = createShortcutRouter();
    const overlay = vi.fn();
    router.registerScope({
      id: 'dialog',
      layer: 'overlay',
      blocksLowerLayers: 'all',
      bindings: [binding('dialog', 'escape', overlay)],
    });
    const dispose = mountShortcutListener(dom.window as unknown as Window, router);
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    dialog.dispatchEvent(event);
    expect(overlay).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    dispose();
  });
});
