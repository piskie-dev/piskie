import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ShortcutOverlayParentProvider,
  mountShortcutListener,
  registerShortcutScope,
  resetShortcutRegistry,
  useDismissShortcutScope,
} from '..';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let disposeListener: () => void;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'Event',
    'KeyboardEvent',
  ] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  resetShortcutRegistry();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  disposeListener = mountShortcutListener(dom.window as unknown as Window);
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeListener();
  resetShortcutRegistry();
  container.remove();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function ChildOverlay({ active, onDismiss }: {
  readonly active: boolean;
  readonly onDismiss: () => void;
}) {
  useDismissShortcutScope({
    scopeIdPrefix: 'test-child',
    active,
    onDismiss,
  });
  return null;
}

function ModalWithChild({ childActive, onChildDismiss }: {
  readonly childActive: boolean;
  readonly onChildDismiss: () => void;
}) {
  const modalScopeId = useDismissShortcutScope({
    scopeIdPrefix: 'test-modal',
    active: true,
    blocksLowerLayers: 'all',
    handling: 'delegate-dismiss',
  });
  return createElement(
    ShortcutOverlayParentProvider,
    { scopeId: modalScopeId },
    createElement(ChildOverlay, { active: childActive, onDismiss: onChildDismiss }),
  );
}

function pressEscape(): KeyboardEvent {
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  dom.window.dispatchEvent(event);
  return event as unknown as KeyboardEvent;
}

describe('dismiss shortcut scopes', () => {
  it('prevents a child dismissal before delegating the next Escape to its modal parent', async () => {
    const childDismiss = vi.fn();
    const lowerAction = vi.fn();
    registerShortcutScope({
      id: 'test-page',
      layer: 'page',
      blocksLowerLayers: 'none',
      bindings: [{
        id: 'test-page:escape',
        commandId: 'test.pageEscape',
        combo: 'escape',
        enabled: () => true,
        handling: 'execute',
        defaultBehavior: 'prevent',
        execute: lowerAction,
      }],
    });

    await act(async () => root.render(createElement(ModalWithChild, {
      childActive: true,
      onChildDismiss: childDismiss,
    })));

    const childEvent = pressEscape();
    expect(childEvent.defaultPrevented).toBe(true);
    expect(childDismiss).toHaveBeenCalledOnce();
    expect(lowerAction).not.toHaveBeenCalled();

    await act(async () => root.render(createElement(ModalWithChild, {
      childActive: false,
      onChildDismiss: childDismiss,
    })));

    const parentEvent = pressEscape();
    expect(parentEvent.defaultPrevented).toBe(false);
    expect(childDismiss).toHaveBeenCalledOnce();
    expect(lowerAction).not.toHaveBeenCalled();
  });

  it('executes the latest dismissal callback without re-registering the scope', async () => {
    const firstDismiss = vi.fn();
    const latestDismiss = vi.fn();
    await act(async () => root.render(createElement(ChildOverlay, {
      active: true,
      onDismiss: firstDismiss,
    })));
    await act(async () => root.render(createElement(ChildOverlay, {
      active: true,
      onDismiss: latestDismiss,
    })));

    pressEscape();

    expect(firstDismiss).not.toHaveBeenCalled();
    expect(latestDismiss).toHaveBeenCalledOnce();
  });
});
