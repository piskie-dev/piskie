import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import {
  act,
  createElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type SVGProps,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SheetShell } from '../../features/envstudio/sheets/SheetShell';
import { HandbookPopover } from '../../features/imdossier/HandbookPopover';
import { PendingPopover } from '../../features/imdossier/PendingPopover';
import { TemplateDropdown } from '../../features/imdossier/TemplateDropdown';
import { IncidentIndicator } from '../../features/incidents/IncidentIndicator';
import { EdgeDock } from '../../features/navhub/EdgeDock';
import { PrismHub } from '../../features/navhub/PrismHub';
import type { NavStop } from '../../features/navhub/nav-stops';
import { DeckSelect } from '../../features/prefdeck/bits/DeckSelect';
import { useIncidentStore } from '../../store/incidentStore';
import { useMessagingStore } from '../../store/messagingStore';
import { mountShortcutListener, registerShortcutScope, resetShortcutRegistry } from '..';

const TestSheetShell = SheetShell as ComponentType<{
  readonly title: string;
  readonly onClose: () => void;
  readonly children?: ReactNode;
}>;

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let disposeListener: () => void;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'SVGElement',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
  ] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  resetShortcutRegistry();
  useIncidentStore.setState({ incidents: [] });
  useMessagingStore.setState({ senderAuthorizationRequests: [] });
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

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element));
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function pressEscape(): Promise<KeyboardEvent> {
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => dom.window.dispatchEvent(event));
  return event as unknown as KeyboardEvent;
}

describe('migrated global Escape owners', () => {
  it('routes custom dropdown and popover dismissal through the application listener', async () => {
    await render(createElement(DeckSelect, {
      options: [{ value: 'one', label: 'One' }],
      value: 'one',
      onPick: vi.fn(),
    }));
    await click(container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!);
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    await render(createElement(TemplateDropdown, {
      claims: [{ id: 'template-one', name: 'Template One', holders: [], lockedByOther: false }],
      value: 'template-one',
      placeholder: 'Choose',
      onPick: vi.fn(),
    }));
    await click(container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!);
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    await render(createElement(PendingPopover));
    await click(container.querySelector<HTMLButtonElement>('[aria-expanded]')!);
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('treats the environment sheet as a modal barrier with an explicit dismissal winner', async () => {
    const onClose = vi.fn();
    await render(createElement(TestSheetShell, { title: 'Environment', onClose }, 'Content'));

    const event = await pressEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('dismisses other custom overlays without retaining hidden shortcut ownership', async () => {
    await render(createElement(HandbookPopover, {
      guide: {
        consoleURL: '',
        steps: [{ title: 'First step', description: 'Example instructions.' }],
      },
    }));
    await click(container.querySelector<HTMLButtonElement>('[aria-expanded]')!);
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => useIncidentStore.setState({
      incidents: [{
        id: 'incident-one',
        timestamp: new Date('2024-01-01T00:00:00Z'),
        severity: 'warning',
        category: 'system',
        source: { agentId: 'agent-one' },
        message: 'Example warning',
      }],
    }));
    await render(createElement(IncidentIndicator));

    const lowerAction = vi.fn();
    const unregisterLower = registerShortcutScope({
      id: 'test-application-scope',
      layer: 'application',
      blocksLowerLayers: 'none',
      bindings: [{
        id: 'test-application-dismiss',
        commandId: 'test.applicationDismiss',
        combo: 'escape',
        enabled: () => true,
        allowInEditable: true,
        handling: 'execute',
        defaultBehavior: 'prevent',
        execute: lowerAction,
      }],
    });

    await click(container.querySelector<HTMLButtonElement>('[aria-expanded]')!);
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(lowerAction).not.toHaveBeenCalled();

    await click(container.querySelector<HTMLButtonElement>('[aria-expanded]')!);
    await act(async () => useIncidentStore.setState({ incidents: [] }));
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(lowerAction).toHaveBeenCalledOnce();
    unregisterLower();
  });

  it('dismisses concurrently open navigation overlays in reverse open order', async () => {
    const Icon = (props: SVGProps<SVGSVGElement>) => createElement('svg', props);
    const stops: readonly NavStop[] = [{
      path: '/one',
      title: 'One',
      Icon,
      live: false,
    }];
    await render(createElement('div', null,
      createElement(EdgeDock, { stops, activePath: '/one', onGo: vi.fn() }),
      createElement(PrismHub, {
        stops,
        activePath: '/one',
        onGo: vi.fn(),
        tone: 'calm',
        spot: null,
        onSpot: vi.fn(),
      }),
    ));

    const nav = container.querySelector('nav')!;
    const edgeTrigger = nav.previousElementSibling as HTMLButtonElement;
    const prismTrigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await click(edgeTrigger);
    await click(prismTrigger);
    expect(nav.getAttribute('aria-hidden')).toBe('false');
    expect(prismTrigger.getAttribute('aria-expanded')).toBe('true');

    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(prismTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(nav.getAttribute('aria-hidden')).toBe('false');

    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(nav.getAttribute('aria-hidden')).toBe('true');
  });
});
