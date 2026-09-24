const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'KeyboardEvent'] as const) {
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

import { DEFAULT_SETTINGS } from '../../../../../shared/constants';
import { mountShortcutListener, resetShortcutRegistry } from '../../../../shortcuts';
import { useUIStore } from '../../../../store/uiStore';
import { useConsoleKeyboard } from '../useConsoleKeyboard';

let root: Root;
let container: HTMLDivElement;
let disposeListener: () => void;
const toggle = vi.fn();

function Harness({ enabled = true }: { readonly enabled?: boolean }) {
  useConsoleKeyboard({ toggleModeEnabled: enabled, onToggleMode: toggle });
  return null;
}

async function press(key: string): Promise<KeyboardEvent> {
  const event = new testDOM.window.KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => window.dispatchEvent(event));
  return event as unknown as KeyboardEvent;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'piskie', {
    configurable: true,
    value: { desktop: { system: { platform: 'linux' } } },
  });
  resetShortcutRegistry();
  toggle.mockReset();
  useUIStore.getState().setSettings({ ...DEFAULT_SETTINGS, shortcuts: {} });
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
  useUIStore.setState({ settings: null });
  container.remove();
  vi.unstubAllGlobals();
});

afterAll(() => testDOM.window.close());

describe('useConsoleKeyboard', () => {
  it('tracks the effective layout shortcut and unregisters it when disabled', async () => {
    expect((await press('\\')).defaultPrevented).toBe(true);
    expect(toggle).toHaveBeenCalledOnce();

    await act(async () => useUIStore.getState().setSettings({
      ...DEFAULT_SETTINGS,
      shortcuts: { 'console.toggleLayout': 'primary+l' },
    }));
    expect((await press('\\')).defaultPrevented).toBe(false);
    expect((await press('l')).defaultPrevented).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(2);

    await act(async () => useUIStore.getState().setSettings({
      ...DEFAULT_SETTINGS,
      shortcuts: { 'console.toggleLayout': null },
    }));
    expect((await press('l')).defaultPrevented).toBe(false);
    expect(toggle).toHaveBeenCalledTimes(2);
  });
});
