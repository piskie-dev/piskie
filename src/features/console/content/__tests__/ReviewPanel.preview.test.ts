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
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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

function displayedSourceLines(): string[] {
  return [...container.querySelectorAll('[class*="sourceLineNo"]')].map((element) => element.textContent ?? '');
}

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
    expect(displayedSourceLines()).toEqual(['1', '3']);
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
    expect(displayedSourceLines()).toEqual(['1']);
  });

  it('keeps source ranges and document structure when reading a Markdown section', async () => {
    const content = [
      '# Sample', '', 'First source line', 'continues on another line.', '',
      '- First entry', '  - Nested entry', '- Last entry', '',
      '| Key | Value |', '| --- | --- |', '| Sample | **ready** |', '',
      '> Sample quote', '> wraps in source.', '',
      '~~~ts', 'const sample = 1;', 'const next = 2;', '~~~', '',
      '[ref]: https://example.test/sample', '  "Reference title"', '',
      'Open [sample][ref] and /workspace/sample.txt.',
    ].join('\n');
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    await act(async () => root.render(createElement(ReviewPanel, {
      change: null, preview: null,
      read: { kind: 'read', path: '/workspace/sample.md', content, startLine: 31 },
      onOpenPath: noop, onRevealPath: noop,
    })));

    expect(displayedSourceLines()).toEqual(['31', '33–34', '36–38', '40–42', '44–45', '47–50', '55']);
    expect(container.querySelector('h1')?.textContent).toBe('Sample');
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(container.querySelector('table strong')?.textContent).toBe('ready');
    expect(container.querySelector('blockquote')?.textContent).toContain('Sample quote');
    expect(container.querySelector('pre code')?.textContent).toBe('const sample = 1;\nconst next = 2;\n');
    expect(container.querySelector('[data-content-target="url"]')?.getAttribute('href'))
      .toBe('https://example.test/sample');
    expect(container.querySelector('[data-content-target="path"]')?.getAttribute('data-target'))
      .toBe('/workspace/sample.txt');

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="复制内容"]')?.click());
    expect(copy).toHaveBeenCalledWith(content);
  });

  it.each([
    { content: '\r\n## Sample\r\n\r\nFirst line\r\nsecond line\r\n', expected: ['42', '44–45'] },
    { content: '# First\n## Next\nParagraph\n    continued\n', expected: ['41', '42', '43–44'] },
    { content: '[ref]: https://example.test/\n  "Title\nRepeated\nend"\n\nRepeated', expected: ['46'] },
    { content: 'Sample heading\n===\n\n---\n\nAfter the rule.', expected: ['41–42', '44', '46'] },
    { content: '<section>\nSample text\n</section>\n\n**After HTML**', expected: ['41–43', '45'] },
  ])('maps the original lines through Markdown syntax: $expected', async ({ content, expected }) => {
    await act(async () => root.render(createElement(ReviewPanel, {
      change: null, preview: null,
      read: { kind: 'read', path: '/workspace/sample.md', content, startLine: 41 },
      onOpenPath: noop, onRevealPath: noop,
    })));
    expect(displayedSourceLines()).toEqual(expected);
  });

  it('updates the ranges when the displayed document or read offset changes', async () => {
    for (const startLine of [1, 71]) {
      await act(async () => root.render(createElement(ReviewPanel, {
        change: null, preview: null,
        read: { kind: 'read', path: '/workspace/sample.md', content: '# Sample\n\nA paragraph.', startLine },
        onOpenPath: noop, onRevealPath: noop,
      })));
      expect(displayedSourceLines()).toEqual([String(startLine), String(startLine + 2)]);
    }
    await act(async () => root.render(createElement(ReviewPanel, {
      change: null, preview: null,
      read: { kind: 'read', path: '/workspace/next.md', content: 'A new paragraph.', startLine: 71 },
      onOpenPath: noop, onRevealPath: noop,
    })));
    expect(displayedSourceLines()).toEqual(['71']);
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

    const rows = container.querySelectorAll('[data-source-start]');
    expect(rows).toHaveLength(2);
    expect(displayedSourceLines()).toEqual(['1', '2']);
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
