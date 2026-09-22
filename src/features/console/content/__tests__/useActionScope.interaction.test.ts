const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Event', 'KeyboardEvent', 'MouseEvent'] as const) {
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
import type { ToolNode, TranscriptAction, TranscriptNode } from '../../../../domains/transcript/nodes';
import { mountShortcutListener, resetShortcutRegistry } from '../../../../shortcuts';
import { useUIStore } from '../../../../store/uiStore';
import { useActionScope } from '../useActionScope';

const tool = (enabled = true): ToolNode => ({
  kind: 'tool',
  id: 'tool-example',
  ts: 0,
  sourceIndex: 0,
  tool: 'shell',
  titleKey: 'tool-example',
  tone: 'neutral',
  interaction: 'expand',
  defaultExpanded: false,
  summaryDuplicatesDetail: false,
  actions: [{ kind: 'promote-to-background', callId: 'call-example', enabled }],
  state: { phase: 'running' },
});

let root: Root;
let container: HTMLDivElement;
let disposeListener: () => void;
let nodes: readonly TranscriptNode[];
const onAction = vi.fn((_node: TranscriptNode, _action: TranscriptAction) => undefined);

function Harness() {
  const handlers = useActionScope({ scopeId: 'panel-example', nodes, onAction });
  return createElement('section', { 'data-panel': 'example', ...handlers });
}

async function render(): Promise<HTMLElement> {
  await act(async () => root.render(createElement(Harness)));
  const panel = container.querySelector<HTMLElement>('[data-panel="example"]')!;
  await act(async () => panel.dispatchEvent(new testDOM.window.MouseEvent('pointerdown', { bubbles: true })));
  return panel;
}

async function press(key: string, ctrlKey = false): Promise<KeyboardEvent> {
  const event = new testDOM.window.KeyboardEvent('keydown', {
    key,
    ctrlKey,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => window.dispatchEvent(event));
  return event as unknown as KeyboardEvent;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'piskie', {
    configurable: true,
    value: { desktop: { system: { platform: 'linux' } } },
  });
  resetShortcutRegistry();
  useUIStore.getState().setSettings({ ...DEFAULT_SETTINGS, shortcuts: {} });
  nodes = [];
  onAction.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  disposeListener = mountShortcutListener(testDOM.window as unknown as Window);
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

describe('useActionScope shortcut routing', () => {
  it('does not consume the configured key when no executable action exists', async () => {
    nodes = [tool(false)];
    await render();

    expect((await press('b', true)).defaultPrevented).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('executes the latest eligible action using the current configured key', async () => {
    nodes = [tool()];
    await render();

    const defaultEvent = await press('b', true);
    expect(defaultEvent.defaultPrevented).toBe(true);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction.mock.calls[0]?.[1]).toMatchObject({
      kind: 'promote-to-background',
      callId: 'call-example',
    });

    onAction.mockClear();
    await act(async () => useUIStore.getState().setSettings({
      ...DEFAULT_SETTINGS,
      shortcuts: { 'tool.promoteToBackground': 'primary+k' },
    }));
    expect((await press('b', true)).defaultPrevented).toBe(false);
    expect((await press('k', true)).defaultPrevented).toBe(true);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('does not consume any key after the command is disabled', async () => {
    nodes = [tool()];
    useUIStore.getState().setSettings({
      ...DEFAULT_SETTINGS,
      shortcuts: { 'tool.promoteToBackground': null },
    });
    await render();

    expect((await press('b', true)).defaultPrevented).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });
});
