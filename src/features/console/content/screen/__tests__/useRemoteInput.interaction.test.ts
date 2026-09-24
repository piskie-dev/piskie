const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Event', 'KeyboardEvent'] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? dom.window : dom.window[name],
    });
  }
  return dom;
});

import { act, createElement, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mountShortcutListener,
  resetShortcutRegistry,
  useShortcutOwner,
  useShortcutScope,
  type ShortcutScope,
} from '@/shortcuts';
import { useRemoteInput } from '../useRemoteInput';

let root: Root;
let container: HTMLDivElement;
let disposeListener: () => void;
const send = vi.fn();
const interrupt = vi.fn();

function Harness() {
  const input = useRemoteInput({
    enabled: true,
    frameSize: { width: 1280, height: 720 },
    send,
  });
  const ownerScope = useMemo<ShortcutScope>(() => ({
    id: 'test-remote-primary-owner',
    layer: 'active-primary-action',
    blocksLowerLayers: 'none',
    bindings: [
      {
        id: 'test-remote-primary-owner:escape',
        commandId: 'agent.interruptCurrent',
        combo: 'escape',
        enabled: () => true,
        allowInEditable: true,
        handling: 'execute',
        defaultBehavior: 'prevent',
        execute: interrupt,
      },
      {
        id: 'test-remote-primary-owner:custom',
        commandId: 'agent.interruptCurrent',
        combo: 'ctrl+shift+x',
        enabled: () => true,
        allowInEditable: true,
        handling: 'execute',
        defaultBehavior: 'prevent',
        execute: interrupt,
      },
    ],
  }), []);
  useShortcutScope(ownerScope);
  useShortcutOwner(ownerScope.id);
  return createElement('div', {
    ...input,
    ref: input.ref,
    tabIndex: 0,
    'data-remote-input': 'true',
  });
}

async function press(target: EventTarget, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new testDOM.window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => target.dispatchEvent(event));
  return event as unknown as KeyboardEvent;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetShortcutRegistry();
  send.mockReset();
  interrupt.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  disposeListener = mountShortcutListener(testDOM.window as unknown as Window);
  await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeListener();
  resetShortcutRegistry();
  container.remove();
  vi.unstubAllGlobals();
});

afterAll(() => testDOM.window.close());

describe('useRemoteInput exclusive shortcut scope', () => {
  it('forwards Escape remotely and blocks local custom shortcuts while focused', async () => {
    const host = container.querySelector<HTMLElement>('[data-remote-input="true"]')!;
    await act(async () => host.focus());

    expect((await press(host, { key: 'Escape' })).defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'key',
      type: 'keyDown',
      key: 'Escape',
    }));
    expect(interrupt).not.toHaveBeenCalled();

    const custom = await press(host, { key: 'X', ctrlKey: true, shiftKey: true });
    expect(custom.defaultPrevented).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();

    await act(async () => host.blur());
    expect((await press(window, { key: 'X', ctrlKey: true, shiftKey: true })).defaultPrevented)
      .toBe(true);
    expect(interrupt).toHaveBeenCalledOnce();
  });
});
