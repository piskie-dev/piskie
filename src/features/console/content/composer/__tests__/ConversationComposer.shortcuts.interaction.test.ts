const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLTextAreaElement',
    'Event',
    'InputEvent',
    'KeyboardEvent',
    'MouseEvent',
  ] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? dom.window : dom.window[name],
    });
  }
  return dom;
});

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from 'i18next';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../../../../../../shared/constants';
import { useUIStore } from '../../../../../store/uiStore';
import { mountShortcutListener, resetShortcutRegistry } from '../../../../../shortcuts';
import { clearAllComposerDrafts } from '../../../data/composer-drafts';
import { ConversationComposer, type ConversationComposerProps } from '../ConversationComposer';

vi.mock('../ModelPicker', () => ({ ModelPicker: () => null }));
vi.mock('../ContextUsageRing', () => ({ ContextUsageRing: () => null }));
vi.mock('../WorkspaceBar', () => ({ WorkspaceBar: () => null }));
vi.mock('../useComposerSettings', () => ({ useComposerSettings: () => ({ modelGroups: [] }) }));
vi.mock('../../../chrome/Popover', () => ({
  Popover: ({ trigger }: { readonly trigger: ReactNode }) => trigger,
}));
vi.mock('../../../chrome/Tooltip', () => ({
  Tooltip: ({ title, children }: { readonly title: ReactNode; readonly children: ReactNode }) => (
    createElement('span', { 'data-tooltip': typeof title === 'string' ? title : '' }, children)
  ),
}));

let container: HTMLDivElement;
let root: Root;
let disposeListener: () => void;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function settings(shortcuts: typeof DEFAULT_SETTINGS.shortcuts) {
  return { ...DEFAULT_SETTINGS, shortcuts };
}

const baseProps: ConversationComposerProps = {
  agentId: 'session-example',
  targetName: 'Example task',
  model: 'sample-model',
  reasoningOverride: { kind: 'provider-default' },
  approvalMode: 'confirm',
  sourceVersion: 0,
  canPause: true,
  isShortcutOwner: true,
  onSubmit: vi.fn().mockResolvedValue(true),
  onInterrupt: vi.fn().mockResolvedValue(undefined),
};

async function render(props: Partial<ConversationComposerProps> = {}): Promise<void> {
  await act(async () => root.render(createElement(ConversationComposer, { ...baseProps, ...props })));
}

function textarea(rootElement: ParentNode = container): HTMLTextAreaElement {
  return rootElement.querySelector<HTMLTextAreaElement>('textarea')!;
}

function action(rootElement: ParentNode = container): HTMLButtonElement {
  return rootElement.querySelector<HTMLButtonElement>('[class*="mainAction"]')!;
}

async function press(
  target: EventTarget,
  init: KeyboardEventInit,
): Promise<KeyboardEvent> {
  const event = new testDOM.window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => target.dispatchEvent(event));
  return event as unknown as KeyboardEvent;
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, 'piskie', {
    configurable: true,
    value: {
      desktop: { system: { platform: 'linux' } },
      capabilities: {
        market: { availableSkills: vi.fn().mockResolvedValue([]), observeChanges: () => () => undefined },
      },
      modes: { listAvailable: vi.fn().mockResolvedValue([]) },
    },
  });
  resetShortcutRegistry();
  clearAllComposerDrafts();
  useUIStore.getState().setSettings(settings({}));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  disposeListener = mountShortcutListener(testDOM.window as unknown as Window);
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeListener();
  resetShortcutRegistry();
  clearAllComposerDrafts();
  useUIStore.setState({ settings: null });
  container.remove();
  vi.unstubAllGlobals();
});

afterAll(() => testDOM.window.close());

describe('ConversationComposer interrupt shortcut', () => {
  it('interrupts once on the default Escape without blurring and removes the hint while pending', async () => {
    const pending = deferred();
    const onInterrupt = vi.fn(() => pending.promise);
    await render({ onInterrupt });
    const input = textarea();
    input.focus();

    expect(action().getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(action().closest('[data-tooltip]')?.getAttribute('data-tooltip'))
      .toBe('Interrupt this task and its subtasks (Esc)');

    const first = new testDOM.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    });
    const second = new testDOM.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    });
    await act(async () => {
      input.dispatchEvent(first);
      input.dispatchEvent(second);
    });

    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(first.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(action().disabled).toBe(true);
    expect(action().getAttribute('aria-label')).toBe('Interrupting');
    expect(action().hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(action().closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Interrupting');

    await act(async () => pending.resolve());
    expect(action().disabled).toBe(false);
    expect(action().getAttribute('aria-keyshortcuts')).toBe('Escape');
  });

  it('blurs on Escape after a rebind and interrupts once on the new editable combo', async () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    useUIStore.getState().setSettings(settings({
      'agent.interruptCurrent': 'primary+shift+x',
    }));
    await render({ onInterrupt });
    const input = textarea();
    input.focus();

    expect(action().getAttribute('aria-keyshortcuts')).toBe('Control+Shift+X');
    expect(action().closest('[data-tooltip]')?.getAttribute('data-tooltip'))
      .toBe('Interrupt this task and its subtasks (Ctrl+Shift+X)');
    expect((await press(input, { key: 'Escape' })).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(input);
    expect(onInterrupt).not.toHaveBeenCalled();

    input.focus();
    expect((await press(input, { key: 'X', ctrlKey: true, shiftKey: true })).defaultPrevented)
      .toBe(true);
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
  });

  it('reacts to live settings updates and leaves Escape as blur when disabled', async () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    await render({ onInterrupt });
    expect(action().getAttribute('aria-keyshortcuts')).toBe('Escape');

    await act(async () => useUIStore.getState().setSettings(settings({
      'agent.interruptCurrent': 'primary+shift+x',
    })));
    expect(action().getAttribute('aria-keyshortcuts')).toBe('Control+Shift+X');
    const input = textarea();
    input.focus();
    await press(input, { key: 'X', ctrlKey: true, shiftKey: true });
    expect(onInterrupt).toHaveBeenCalledOnce();

    await act(async () => useUIStore.getState().setSettings(settings({
      'agent.interruptCurrent': null,
    })));
    expect(action().hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(action().closest('[data-tooltip]')?.getAttribute('data-tooltip'))
      .toBe('Interrupt this task and its subtasks');
    input.focus();
    await press(input, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
    expect(onInterrupt).toHaveBeenCalledOnce();
  });

  it('preserves IME composition and focus when Escape is not the interrupt shortcut', async () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    useUIStore.getState().setSettings(settings({
      'agent.interruptCurrent': 'primary+shift+x',
    }));
    await render({ onInterrupt });
    const input = textarea();
    input.focus();

    const event = await press(input, { key: 'Escape', isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('assigns one shortcut target across two Dock-style composers while both buttons remain clickable', async () => {
    const mainInterrupt = vi.fn().mockResolvedValue(undefined);
    const workerInterrupt = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(createElement('div', null,
      createElement('section', { 'data-target': 'main' }, createElement(ConversationComposer, {
        ...baseProps,
        onInterrupt: mainInterrupt,
        isShortcutOwner: true,
      })),
      createElement('section', { 'data-target': 'worker' }, createElement(ConversationComposer, {
        ...baseProps,
        workerId: 'worker-example',
        targetName: 'Example worker',
        onInterrupt: workerInterrupt,
        isShortcutOwner: false,
      })),
    )));
    const main = container.querySelector<HTMLElement>('[data-target="main"]')!;
    const worker = container.querySelector<HTMLElement>('[data-target="worker"]')!;

    expect(action(main).getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(action(worker).hasAttribute('aria-keyshortcuts')).toBe(false);
    await press(window, { key: 'Escape' });
    expect(mainInterrupt).toHaveBeenCalledOnce();
    expect(workerInterrupt).not.toHaveBeenCalled();

    await act(async () => action(worker).click());
    expect(workerInterrupt).toHaveBeenCalledOnce();
  });

  it('lets an open SkillPicker consume the first Escape before interrupt', async () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    await render({ onInterrupt });
    const input = textarea();
    input.focus();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      valueSetter.call(input, '/');
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data: '/',
        bubbles: true,
      }));
    });
    expect(container.querySelector('[popover="manual"]')).not.toBeNull();

    expect((await press(input, { key: 'Escape' })).defaultPrevented).toBe(true);
    expect(container.querySelector('[popover="manual"]')).toBeNull();
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    expect((await press(input, { key: 'Escape' })).defaultPrevented).toBe(true);
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
  });
});
