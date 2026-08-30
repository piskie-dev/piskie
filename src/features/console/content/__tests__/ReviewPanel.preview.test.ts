import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let ReviewPanel: typeof import('../ReviewPanel').ReviewPanel;
const nodeRequire = createRequire(import.meta.url);
const previousCssLoader = nodeRequire.extensions['.css'];

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://piskie.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('SVGElement', dom.window.SVGElement);
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
  nodeRequire.extensions['.css'] = () => undefined;
  ({ ReviewPanel } = await import('../ReviewPanel'));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  if (previousCssLoader) nodeRequire.extensions['.css'] = previousCssLoader;
  else delete nodeRequire.extensions['.css'];
  dom.window.close();
  vi.unstubAllGlobals();
});

const noop = (): void => undefined;

describe('ReviewPanel path preview', () => {
  it('renders a Markdown path as a document', async () => {
    await act(async () => {
      root.render(createElement(ReviewPanel, {
        change: null,
        read: null,
        preview: {
          path: '/workspace/ROADMAP.md',
          descriptor: {
            kind: 'text',
            content: '# Roadmap\n\nShip **preview**.',
            truncated: false,
            size: 28,
          },
        },
        onOpenPath: noop,
        onRevealPath: noop,
      }));
    });

    expect(container.querySelector('h1')?.textContent).toBe('Roadmap');
    expect(container.querySelector('strong')?.textContent).toBe('preview');
  });

  it('uses the same Markdown document renderer for a read operation', async () => {
    await act(async () => {
      root.render(createElement(ReviewPanel, {
        change: null,
        read: { kind: 'read', path: '/workspace/notes.md', content: '## Notes', startLine: 1 },
        preview: null,
        onOpenPath: noop,
        onRevealPath: noop,
      }));
    });

    expect(container.querySelector('h2')?.textContent).toBe('Notes');
  });

  it('renders non-Markdown text as line-numbered source and reports truncation', async () => {
    await act(async () => {
      root.render(createElement(ReviewPanel, {
        change: null,
        read: null,
        preview: {
          path: '/workspace/app.ts',
          descriptor: {
            kind: 'text',
            content: 'const first = 1;\nconst second = 2;',
            truncated: true,
            size: 500 * 1024,
          },
        },
        onOpenPath: noop,
        onRevealPath: noop,
      }));
    });

    const rows = container.querySelectorAll('[data-kind="context"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('1');
    expect(container.textContent).toContain('仅显示前 384KB');
  });

  it('shows unsupported local files as an actionable file card', async () => {
    const open = vi.fn();
    const reveal = vi.fn();
    await act(async () => {
      root.render(createElement(ReviewPanel, {
        change: null,
        read: null,
        preview: {
          path: '/workspace/report.pdf',
          descriptor: { kind: 'file', mediaType: 'application/pdf', size: 2048 },
        },
        onOpenPath: open,
        onRevealPath: reveal,
      }));
    });

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
    const openButton = buttons.find((button) => button.textContent?.includes('用系统应用打开'));
    const revealButton = buttons.find((button) => button.textContent?.includes('在文件夹中显示'));
    expect(container.textContent).toContain('application/pdf');

    await act(async () => openButton?.click());
    await act(async () => revealButton?.click());

    expect(open).toHaveBeenCalledWith('/workspace/report.pdf');
    expect(reveal).toHaveBeenCalledWith('/workspace/report.pdf');
  });
});
