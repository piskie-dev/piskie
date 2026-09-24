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
    'HTMLDialogElement',
    'Event',
    'KeyboardEvent',
  ] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? dom.window : dom.window[name],
    });
  }
  return dom;
});

import {
  act,
  createElement,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mountShortcutListener,
  resetShortcutRegistry,
  useShortcutOwner,
  useShortcutScope,
  type ShortcutScope,
} from '@/shortcuts';
import { Dialog } from '../Dialog';
import { Popover } from '../Popover';

const TestDialog = Dialog as ComponentType<{
  readonly open: boolean;
  readonly onClose: () => void;
  readonly ariaLabel: string;
  readonly children?: ReactNode;
}>;
const TestPopover = Popover as ComponentType<{
  readonly open: boolean;
  readonly onClose: () => void;
  readonly trigger: ReactNode;
  readonly children?: ReactNode;
}>;

let root: Root;
let container: HTMLDivElement;
let disposeListener: () => void;
const interrupt = vi.fn();
const closePopover = vi.fn();

beforeAll(() => {
  const nativeMatches = testDOM.window.Element.prototype.matches;
  Object.defineProperty(testDOM.window.Element.prototype, 'matches', {
    configurable: true,
    value(this: Element, selector: string) {
      if (selector === ':popover-open') return this.hasAttribute('data-test-popover-open');
      return nativeMatches.call(this, selector);
    },
  });
  Object.defineProperty(testDOM.window.HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value(this: HTMLElement) {
      this.setAttribute('data-test-popover-open', '');
    },
  });
  Object.defineProperty(testDOM.window.HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value(this: HTMLElement) {
      this.removeAttribute('data-test-popover-open');
      const event = new testDOM.window.Event('toggle');
      Object.defineProperty(event, 'newState', { value: 'closed' });
      this.dispatchEvent(event);
    },
  });
  Object.defineProperty(testDOM.window.HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(testDOM.window.HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new testDOM.window.Event('close'));
    },
  });
});

function Harness() {
  const [dialogOpen, setDialogOpen] = useState(true);
  const [popoverOpen, setPopoverOpen] = useState(true);
  const ownerScope = useMemo<ShortcutScope>(() => ({
    id: 'test-overlay-primary-owner',
    layer: 'active-primary-action',
    blocksLowerLayers: 'none',
    bindings: [
      {
        id: 'test-overlay-primary-owner:escape',
        commandId: 'agent.interruptCurrent',
        combo: 'escape',
        enabled: () => true,
        handling: 'execute',
        defaultBehavior: 'prevent',
        execute: interrupt,
      },
      {
        id: 'test-overlay-primary-owner:custom',
        commandId: 'agent.interruptCurrent',
        combo: 'ctrl+shift+x',
        enabled: () => true,
        handling: 'execute',
        defaultBehavior: 'prevent',
        execute: interrupt,
      },
    ],
  }), []);
  useShortcutScope(ownerScope);
  useShortcutOwner(ownerScope.id);
  return createElement(TestDialog, {
    open: dialogOpen,
    onClose: () => setDialogOpen(false),
    ariaLabel: 'Example dialog',
    }, createElement(TestPopover, {
      open: popoverOpen,
      onClose: () => {
        closePopover();
        setPopoverOpen(false);
      },
      trigger: createElement('button', { type: 'button' }, 'Open'),
    }, createElement('button', { type: 'button', 'data-popover-content': 'true' }, 'Nested action')));
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
  interrupt.mockReset();
  closePopover.mockReset();
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

describe('managed Console native overlays', () => {
  it('consumes nested dismissal in child-first order and keeps modal commands behind the dialog', async () => {
    const dialog = container.querySelector<HTMLDialogElement>('dialog')!;
    const popover = container.querySelector<HTMLElement>('[popover="auto"]')!;
    const content = container.querySelector<HTMLElement>('[data-popover-content="true"]')!;
    expect(dialog.open).toBe(true);
    expect(popover.matches(':popover-open')).toBe(true);
    expect(dialog.getAttribute('closedby')).toBe('any');

    const custom = await press(content, { key: 'X', ctrlKey: true, shiftKey: true });
    expect(custom.defaultPrevented).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();

    const first = await press(content, { key: 'Escape' });
    expect(first.defaultPrevented).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
    expect(popover.matches(':popover-open')).toBe(false);
    expect(closePopover).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);

    const second = await press(dialog, { key: 'Escape' });
    expect(second.defaultPrevented).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
    const cancel = new testDOM.window.Event('cancel', { cancelable: true });
    expect(dialog.dispatchEvent(cancel)).toBe(true);
    await act(async () => dialog.close());
    expect(dialog.open).toBe(false);

    const third = await press(window, { key: 'Escape' });
    expect(third.defaultPrevented).toBe(true);
    expect(interrupt).toHaveBeenCalledOnce();
  });
});
