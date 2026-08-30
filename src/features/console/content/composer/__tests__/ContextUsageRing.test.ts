import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

const contextInspector = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  close: vi.fn(),
}));

vi.mock('../../../../../renderer-runtime/hooks', () => ({
  useRendererRuntime: () => ({ contextInspector }),
  useContextInspectorResource: (selector: (value: unknown) => unknown) => selector({
    phase: 'closed',
    agentId: null,
    snapshot: null,
    error: null,
    generation: 0,
  }),
}));

vi.mock('../../../../context-inspector/ContextInspector', () => ({
  ContextInspector: () => null,
}));
vi.mock('../../../../context-inspector/ContextBreakdown', () => ({
  ContextBreakdown: () => null,
}));
vi.mock('../../../chrome/Popover', () => ({
  Popover: ({ trigger, children }: { trigger: ReactNode; children: ReactNode }) =>
    createElement(Fragment, null, trigger, children),
}));
vi.mock('../../../chrome/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

import { ContextUsageRing } from '../ContextUsageRing';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://piskie.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  contextInspector.open.mockClear();
  contextInspector.refresh.mockClear();
  contextInspector.close.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await i18n.changeLanguage('zh-CN');
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function render(usage?: { tokens?: number; limit: number; percentage?: number }): string {
  return renderToStaticMarkup(createElement(ContextUsageRing, {
    usage,
    agentId: 'agent-1',
    sourceVersion: 1,
  }));
}

describe('ContextUsageRing', () => {
  it('keeps unknown distinct from a measured zero and reprojects labels by locale', async () => {
    await i18n.changeLanguage('zh-CN');
    const unknown = render({ limit: 128_000 });
    const zero = render({ tokens: 0, limit: 128_000, percentage: 0 });

    expect(unknown).toContain('上下文 — / 128,000 tokens');
    expect(unknown).toContain('>—</span>');
    expect(unknown).not.toContain('stroke-dasharray');

    expect(zero).toContain('上下文 0 / 128,000 tokens');
    expect(zero).toContain('>0%</span>');
    expect(zero).toContain('stroke-dasharray="0 100"');

    await i18n.changeLanguage('en-US');
    expect(render({ limit: 128_000 })).toContain('Context — / 128,000 tokens');

    await i18n.changeLanguage('zh-CN');
    expect(render({ limit: 128_000 })).toContain('上下文 — / 128,000 tokens');
  });

  it('resets the inspector lease when the target agent changes', async () => {
    await act(async () => {
      root.render(createElement(ContextUsageRing, {
        agentId: 'agent-a',
        sourceVersion: 1,
        viewerEnabled: true,
      }));
    });
    await act(async () => container.querySelector('button')?.click());
    expect(contextInspector.open).toHaveBeenLastCalledWith('agent-a');

    await act(async () => {
      root.render(createElement(ContextUsageRing, {
        agentId: 'agent-b',
        sourceVersion: 1,
        viewerEnabled: true,
      }));
    });
    expect(contextInspector.close).toHaveBeenCalledWith('agent-a');

    await act(async () => container.querySelector('button')?.click());
    expect(contextInspector.open).toHaveBeenLastCalledWith('agent-b');
  });
});
