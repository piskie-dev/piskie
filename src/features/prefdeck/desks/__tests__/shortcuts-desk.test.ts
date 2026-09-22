import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { DEFAULT_SETTINGS } from '@shared/constants';
import {
  DEFAULT_SHORTCUTS,
  FIXED_SHORTCUT_COMMAND_IDS,
  formatShortcutAria,
  formatShortcutVisual,
  type ConfigurableShortcutCommandId,
  type ShortcutOverrides,
} from '@shared/shortcuts';
import type { AppSettings } from '@shared/types';
import {
  dispatchShortcutEvent,
  registerShortcutScope,
  resetShortcutRegistry,
} from '@/shortcuts';
import { useUIStore } from '@/store/uiStore';
import { CatalogPane } from '../../CatalogPane';
import { ShortcutsDesk } from '../ShortcutsDesk';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let persistedSettings: AppSettings;
let writeShortcut: ReturnType<typeof vi.fn>;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  for (const name of [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'SVGElement',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'FocusEvent',
    'localStorage',
  ] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(async () => {
  resetShortcutRegistry();
  await i18n.changeLanguage('zh-CN');
  persistedSettings = structuredClone(DEFAULT_SETTINGS);
  writeShortcut = installPiskie('linux');
  useUIStore.getState().setSettings(structuredClone(DEFAULT_SETTINGS));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  resetShortcutRegistry();
  container.remove();
  vi.restoreAllMocks();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('shortcut preferences navigation and catalog', () => {
  it('opens the independent Application section without listing system-reserved shortcuts', async () => {
    const onSect = vi.fn();
    await render(createElement(CatalogPane, {
      searchProviders: [],
      pickedSearch: null,
      onSearchProvider: vi.fn(),
      sect: 'look',
      providers: { ai: [], image: [] },
      picked: { ai: null, image: null },
      onSect,
      onProvider: vi.fn(),
      onAddProvider: vi.fn(),
    }));

    await click(buttonWithText('键盘快捷键'));
    expect(onSect).toHaveBeenCalledWith('shortcuts');

    await render(createElement(ShortcutsDesk));
    expect(container.textContent).not.toContain('shortcuts.');
    expect([...container.querySelectorAll('section h2')].map((heading) => heading.textContent))
      .toEqual(['可修改', '固定交互']);
    expect(container.querySelectorAll('[data-shortcut-id]').length).toBe(
      3 + FIXED_SHORTCUT_COMMAND_IDS.length,
    );
    expect(shortcutRow('agent.interruptCurrent').textContent).toContain('中断当前 Agent');
    expect(container.querySelector('[data-shortcut-id="system.developerTools"]')).toBeNull();
    expect(container.textContent).not.toContain('系统保留');
  });

  it('keeps fixed rows locked, readable, and non-editable', async () => {
    await renderShortcuts();

    for (const commandId of FIXED_SHORTCUT_COMMAND_IDS) {
      const row = shortcutRow(commandId);
      expect(row.dataset.locked).toBe('true');
      expect(row.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('锁定的快捷键');
      expect(row.querySelector('button')).toBeNull();
      expect(row.textContent?.trim().length).toBeGreaterThan(0);
      await click(row);
      expect(row.dataset.capturing).toBeUndefined();
    }
    expect(container.querySelector('[aria-keyshortcuts]')).toBeNull();
  });
});

describe('shortcut capture and persistence', () => {
  it('blocks lower scopes, captures Escape, previews a modifier, and saves a full combo', async () => {
    await renderShortcuts({ 'agent.interruptCurrent': null });
    const lowerAction = vi.fn();
    registerShortcutScope({
      id: 'shortcut-test-lower-scope',
      layer: 'application',
      blocksLowerLayers: 'none',
      bindings: [{
        id: 'shortcut-test-lower-binding',
        commandId: 'test.lower',
        combo: 'escape',
        enabled: () => true,
        handling: 'execute',
        defaultBehavior: 'prevent',
        execute: lowerAction,
      }],
    });

    await click(actionButton('agent.interruptCurrent', 'edit'));
    expect(dispatchShortcutEvent({ key: 'Escape', preventDefault: vi.fn() })).toMatchObject({
      kind: 'blocked',
      layer: 'exclusive-input',
    });
    expect(lowerAction).not.toHaveBeenCalled();

    await keydown(captureButton('agent.interruptCurrent'), { key: 'Escape' });
    expect(writeShortcut).toHaveBeenNthCalledWith(1, 'agent.interruptCurrent', 'escape');
    expect(actionButton('agent.interruptCurrent', 'edit').textContent).toContain('Esc');
    expect(document.activeElement).toBe(actionButton('agent.interruptCurrent', 'edit'));

    await click(actionButton('agent.interruptCurrent', 'edit'));
    await keydown(captureButton('agent.interruptCurrent'), { key: 'Control' });
    expect(captureButton('agent.interruptCurrent').textContent).toContain('Ctrl');
    expect(captureButton('agent.interruptCurrent').getAttribute('aria-live')).toBe('polite');
    expect(captureButton('agent.interruptCurrent').getAttribute('aria-label')).toContain('Ctrl');
    expect(writeShortcut).toHaveBeenCalledTimes(1);

    await keydown(captureButton('agent.interruptCurrent'), {
      key: 'X',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(writeShortcut).toHaveBeenNthCalledWith(
      2,
      'agent.interruptCurrent',
      'primary+shift+x',
    );
    expect(actionButton('agent.interruptCurrent', 'edit').textContent).toContain('Ctrl+Shift+X');
    expect(actionButton('agent.interruptCurrent', 'edit').hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(actionButton('agent.interruptCurrent', 'edit').getAttribute('aria-label'))
      .toContain('Control+Shift+X');
  });

  it('rejects illegal, editor-reserved, system-reserved, and physically conflicting input inline', async () => {
    await renderShortcuts();
    await click(actionButton('console.toggleLayout', 'edit'));

    await keydown(captureButton('console.toggleLayout'), { key: 'X' });
    expect(alertText()).toContain('请使用 Esc');

    await keydown(captureButton('console.toggleLayout'), { key: 'C', ctrlKey: true });
    expect(alertText()).toBe('这个快捷键由文本编辑功能保留。');

    await keydown(captureButton('console.toggleLayout'), { key: 'R', ctrlKey: true });
    expect(alertText()).toBe('这个快捷键由应用窗口保留。');

    await keydown(captureButton('console.toggleLayout'), { key: 'B', ctrlKey: true });
    expect(alertText()).toContain('将运行中的工具转入后台');
    expect(writeShortcut).not.toHaveBeenCalled();
    expect(captureButton('console.toggleLayout')).toBeTruthy();
  });

  it('writes null to disable and deletes only that override to restore the default', async () => {
    await renderShortcuts({ 'console.toggleLayout': 'primary+x' });

    await click(actionButton('console.toggleLayout', 'clear'));
    expect(writeShortcut).toHaveBeenNthCalledWith(1, 'console.toggleLayout', null);
    expect(actionButton('console.toggleLayout', 'edit').textContent).toContain('已禁用');

    await click(actionButton('console.toggleLayout', 'restore'));
    expect(writeShortcut).toHaveBeenNthCalledWith(
      2,
      'console.toggleLayout',
      DEFAULT_SHORTCUTS['console.toggleLayout'],
    );
    expect(actionButton('console.toggleLayout', 'edit').textContent).toContain('Ctrl+\\');
  });

  it('cancels capture with the X button, blur, or an outside pointer action', async () => {
    await renderShortcuts();

    await click(actionButton('agent.interruptCurrent', 'edit'));
    await click(requiredElement<HTMLButtonElement>('[aria-label="取消修改快捷键"]'));
    expect(shortcutRow('agent.interruptCurrent').dataset.capturing).toBeUndefined();
    expect(document.activeElement).toBe(actionButton('agent.interruptCurrent', 'edit'));

    await click(actionButton('agent.interruptCurrent', 'edit'));
    const outside = document.createElement('button');
    document.body.append(outside);
    await act(async () => {
      captureButton('agent.interruptCurrent').focus();
      outside.focus();
    });
    expect(shortcutRow('agent.interruptCurrent').dataset.capturing).toBeUndefined();

    await click(actionButton('agent.interruptCurrent', 'edit'));
    await act(async () => {
      document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(shortcutRow('agent.interruptCurrent').dataset.capturing).toBeUndefined();
    expect(writeShortcut).not.toHaveBeenCalled();
    outside.remove();
  });

  it('announces the pending save and restores focus after it completes', async () => {
    let finishWrite: (() => void) | undefined;
    writeShortcut = installPiskie('linux', vi.fn(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    })));
    await renderShortcuts();

    await click(actionButton('console.toggleLayout', 'edit'));
    await keydown(captureButton('console.toggleLayout'), { key: 'K', ctrlKey: true });

    expect(captureButton('console.toggleLayout').getAttribute('aria-busy')).toBe('true');
    expect(captureButton('console.toggleLayout').getAttribute('aria-label')).toContain('正在保存');

    await act(async () => finishWrite?.());
    await flushEffects();
    expect(document.activeElement).toBe(actionButton('console.toggleLayout', 'edit'));
  });

  it('shows a local error and retains the previous snapshot when saving fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeShortcut = installPiskie('linux', vi.fn(async () => {
      throw new Error('test write failed');
    }));
    await renderShortcuts();

    await click(actionButton('console.toggleLayout', 'edit'));
    await keydown(captureButton('console.toggleLayout'), { key: 'K', ctrlKey: true });

    expect(writeShortcut).toHaveBeenCalledWith('console.toggleLayout', 'primary+k');
    expect(alertText()).toBe('快捷键保存失败，当前设置未改变。');
    expect(captureButton('console.toggleLayout').textContent).toContain('Ctrl+K');
    expect(useUIStore.getState().settings?.shortcuts).toEqual({});
  });

  it('reflects a later settings snapshot without remounting', async () => {
    await renderShortcuts();
    expect(actionButton('tool.promoteToBackground', 'edit').textContent).toContain('Ctrl+B');

    await act(async () => useUIStore.getState().setSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      shortcuts: { 'tool.promoteToBackground': 'primary+shift+x' },
    }));

    expect(actionButton('tool.promoteToBackground', 'edit').textContent).toContain('Ctrl+Shift+X');
  });
});

describe('shortcut platform presentation', () => {
  it('renders macOS primary visually while keeping ARIA tokens separate', async () => {
    installPiskie('darwin');
    await renderShortcuts();

    const edit = actionButton('console.toggleLayout', 'edit');
    expect(edit.textContent).toContain('\u2318\\');
    expect(edit.hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(edit.getAttribute('aria-label')).toContain('Meta+\\');
    expect(formatShortcutVisual('primary+shift+x', 'win32')).toBe('Ctrl+Shift+X');
    expect(formatShortcutVisual('primary+b', 'linux')).toBe('Ctrl+B');
    expect(formatShortcutAria('primary+shift+x', 'win32')).toBe('Control+Shift+X');
  });
});

function installPiskie(
  platform: string,
  beforeWrite?: (
    commandId: ConfigurableShortcutCommandId,
    override: string | null,
  ) => Promise<void>,
): ReturnType<typeof vi.fn> {
  const writer = vi.fn(async (
    commandId: ConfigurableShortcutCommandId,
    override: string | null,
  ) => {
    await beforeWrite?.(commandId, override);
    const shortcuts = { ...persistedSettings.shortcuts };
    if (override === DEFAULT_SHORTCUTS[commandId]) delete shortcuts[commandId];
    else shortcuts[commandId] = override;
    persistedSettings = { ...persistedSettings, shortcuts };
  });
  Object.defineProperty(dom.window, 'piskie', {
    configurable: true,
    value: {
      desktop: { system: { platform } },
      configuration: {
        settings: {
          read: vi.fn(async () => structuredClone(persistedSettings)),
          writeAll: vi.fn(async () => undefined),
          writeShortcut: writer,
        },
      },
    },
  });
  return writer;
}

async function renderShortcuts(shortcuts: ShortcutOverrides = {}): Promise<void> {
  persistedSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    shortcuts,
  };
  useUIStore.getState().setSettings(persistedSettings);
  await render(createElement(ShortcutsDesk));
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element));
  await flushEffects();
}

function shortcutRow(commandId: string): HTMLElement {
  return requiredElement(`[data-shortcut-id="${commandId}"]`);
}

function actionButton(commandId: string, action: string): HTMLButtonElement {
  return requiredElement(`[data-shortcut-id="${commandId}"] [data-action="${action}"]`);
}

function captureButton(commandId: string): HTMLButtonElement {
  return actionButton(commandId, 'capture');
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function requiredElement<T extends Element = HTMLElement>(selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}

function alertText(): string {
  return requiredElement('[role="alert"]').textContent ?? '';
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flushEffects();
}

async function keydown(
  element: HTMLElement,
  init: KeyboardEventInit & { readonly key: string },
): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    }));
  });
  await flushEffects();
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
