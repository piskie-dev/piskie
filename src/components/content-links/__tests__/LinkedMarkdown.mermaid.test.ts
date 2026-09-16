import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceBlockProps } from '../LinkedMarkdown';
import type { MermaidDiagram } from '../mermaidRuntime';
import type { ImagePreviewHandler } from '@/components/image-preview/renderedImageContext';
import ImageLightbox from '@/features/console/content/ImageLightbox';
import { pngBytes } from '@/features/console/attachments/__tests__/fixtures';

const mocks = vi.hoisted(() => ({
  render: vi.fn<(source: string, theme: string) => Promise<MermaidDiagram>>(),
  png: vi.fn<() => Promise<Blob>>(),
  copyImage: vi.fn<() => Promise<void>>(),
  copyText: vi.fn<() => Promise<void>>(),
}));
vi.mock('../mermaidRuntime', () => ({ renderMermaid: mocks.render, mermaidToPng: mocks.png }));
vi.mock('@/services/clipboard', () => ({ copyImage: mocks.copyImage, copyText: mocks.copyText }));

let LinkedMarkdown: typeof import('../LinkedMarkdown').LinkedMarkdown;
let StreamingMarkdown: typeof import('@/features/console/content/StreamingMarkdown').StreamingMarkdown;
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
const nodeRequire = createRequire(import.meta.url);
const previousCssLoader = nodeRequire.extensions['.css'];

function diagram(label: string): MermaidDiagram {
  return { svg: `<svg viewBox="0 0 200 100"><text>${label}</text></svg>`, width: 200, height: 100 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DOMParser', 'MutationObserver'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  nodeRequire.extensions['.css'] = () => undefined;
  ({ LinkedMarkdown } = await import('../LinkedMarkdown'));
  ({ StreamingMarkdown } = await import('@/features/console/content/StreamingMarkdown'));
});
beforeEach(() => {
  document.documentElement.dataset.theme = 'dark';
  mocks.render.mockReset().mockImplementation(async (source, theme) => diagram(`${theme}: ${source}`));
  mocks.png.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  mocks.copyImage.mockReset().mockResolvedValue(undefined);
  mocks.copyText.mockReset().mockResolvedValue(undefined);
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

async function render(markdown: string, live = false) {
  await act(async () => root.render(createElement(StreamingMarkdown, { markdown, live })));
}
function button(text: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => element.textContent === text);
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function renderedSvg() {
  return decodeURIComponent(container.querySelector<HTMLImageElement>('[data-mermaid-view] img')?.src ?? '');
}
function fence(source: string) { return `\`\`\`mermaid\n${source}\n\`\`\``; }

describe('shared Markdown Mermaid dispatch', () => {
  it('opens diagrams as single PNG previews while keeping ordinary SVGs in their own gallery', async () => {
    const urls = ['https://images.example.test/sample.png', 'https://images.example.test/vector.svg'];
    const onPreview = vi.fn<ImagePreviewHandler>();
    const png = new Blob([pngBytes()], { type: 'image/png' });
    mocks.png.mockResolvedValueOnce(png);
    function Gallery() {
      const [preview, setPreview] = useState<{ urls: readonly string[]; index: number; name?: string } | null>(null);
      const release = useRef<(() => void) | undefined>();
      const close = () => { release.current?.(); release.current = undefined; setPreview(null); };
      useEffect(() => () => release.current?.(), []);
      const open: ImagePreviewHandler = (url, contextUrls = [url], index = 0, releaseSource, name) => {
        onPreview(url, contextUrls, index, releaseSource, name);
        release.current?.();
        release.current = releaseSource;
        setPreview({ urls: contextUrls, index, name });
      };
      return createElement('div', null,
        createElement('div', { 'data-image-preview-scope': true },
          createElement(LinkedMarkdown, { onPreviewImage: open }, [
            `![Raster sample](${urls[0]})`, fence('flowchart LR\nA --> B'), `![Vector sample](${urls[1]})`,
          ].join('\n\n'))),
        createElement(ImageLightbox, { preview, onClose: close }));
    }
    await act(async () => root.render(createElement(Gallery)));
    const renderedImages = container.querySelectorAll<HTMLImageElement>('[data-image-preview-scope] img');
    expect(renderedImages).toHaveLength(3);
    await act(async () => {
      for (const image of renderedImages) image.dispatchEvent(new dom.window.Event('load'));
    });
    await act(async () => container.querySelector<HTMLImageElement>('[data-mermaid-view] img')!.click());
    const diagramUrl = container.querySelector<HTMLImageElement>('dialog img')!.src;
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(diagramUrl, [diagramUrl], 0, expect.any(Function), 'diagram.png');
    expect(await (await fetch(diagramUrl)).blob()).toMatchObject({ type: 'image/png', size: png.size });
    expect(container.querySelector('button[aria-label="下一张图片"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('dialog [data-copy-status]')!.click());
    expect(mocks.copyImage).toHaveBeenLastCalledWith({ kind: 'url', url: diagramUrl, name: 'diagram.png' });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="关闭预览"]')!.click());
    await act(async () => container.querySelector<HTMLImageElement>('img[alt="Raster sample"]')!.click());
    expect(onPreview).toHaveBeenLastCalledWith(urls[0], urls, 0, undefined, undefined);
    const picture = () => container.querySelector<HTMLImageElement>('dialog img[alt^="第"]');
    expect(picture()?.src).toBe(urls[0]);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="下一张图片"]')!.click());
    expect(picture()?.src).toBe(urls[1]);
    await act(async () => container.querySelector<HTMLButtonElement>('dialog [data-copy-status]')!.click());
    expect(mocks.copyImage).toHaveBeenLastCalledWith({ kind: 'url', url: urls[1], name: undefined });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="下一张图片"]')!.click());
    expect(picture()?.src).toBe(urls[0]);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="关闭预览"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-mermaid-view] [data-copy-status]')!.click());
    expect(mocks.png).toHaveBeenCalledTimes(2);
    expect(mocks.copyImage).toHaveBeenLastCalledWith({ kind: 'blob', blob: expect.any(Blob), name: 'diagram.png' });
  });

  it('defaults to a diagram outside pre/code and copies a PNG only on click', async () => {
    await render(fence('flowchart LR\n  A[开始] --> B[完成]'));
    expect(mocks.render).toHaveBeenCalledWith('flowchart LR\n  A[开始] --> B[完成]\n', 'dark');
    expect(container.querySelector('[data-mermaid-view]')?.closest('pre, code')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(renderedSvg()).toContain('开始');
    expect(mocks.png).not.toHaveBeenCalled();
    await click('复制图片');
    expect(mocks.png).toHaveBeenCalledOnce();
    expect(mocks.copyImage).toHaveBeenCalledWith({ kind: 'blob', blob: expect.any(Blob), name: 'diagram.png' });
    expect(container.querySelector('[data-copy-status]')?.getAttribute('data-copy-status')).toBe('success');
  });

  it('copies the fence interior with indentation, entities and trailing blank lines intact', async () => {
    const source = '\nflowchart LR\n  A["甲 & <乙>"] --> B\n\n';
    await render(`\`\`\`mermaid\n${source}\`\`\``);
    await click('源码');
    expect(container.querySelector('pre code')?.textContent).toBe(source);
    await click('复制源码');
    expect(mocks.copyText).toHaveBeenCalledWith(source);
    expect(mocks.png).not.toHaveBeenCalled();
    expect(mocks.copyImage).not.toHaveBeenCalled();
  });

  it('keeps incomplete source visible and copyable, then renders when the fence closes', async () => {
    await render('```mermaid\nflowchart LR\n  A -->', true);
    expect(mocks.render).not.toHaveBeenCalled();
    expect(button('复制图片').disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('图表生成中…');
    await click('源码');
    await click('复制源码');
    expect(mocks.copyText).toHaveBeenCalledWith('flowchart LR\n  A -->');
    await render('```mermaid\nflowchart LR\n  A --> B\n```\n\nStill streaming', true);
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-mermaid-view]')?.getAttribute('data-mermaid-view')).toBe('source');
    expect(container.querySelector('pre code')?.textContent).toBe('flowchart LR\n  A --> B\n');
    await click('图形');
    expect(renderedSvg()).toContain('A --> B');
    await render('```mermaid\nflowchart LR\n  A --> B\n```\n\nStill streaming', false);
    expect(mocks.render).toHaveBeenCalledOnce();
  });

  it('renders an unclosed fence when the message finishes, preserving an unterminated last line', async () => {
    const markdown = '```mermaid\nflowchart LR\n  A --> B';
    await render(markdown, true);
    expect(mocks.render).not.toHaveBeenCalled();
    await render(markdown, false);
    expect(mocks.render).toHaveBeenCalledWith('flowchart LR\n  A --> B', 'dark');
    await click('源码');
    await click('复制源码');
    expect(mocks.copyText).toHaveBeenCalledWith('flowchart LR\n  A --> B');
  });

  it.each([
    '~~~mermaid\nflowchart LR\nA --> B\n~~~~',
    '````mermaid\nflowchart LR\nA --> B\n`````',
    '> ```mermaid\n> flowchart LR\n> A --> B\n> ```\n',
    '- Example\n\n  ```mermaid\n  flowchart LR\n  A --> B\n  ```\n',
  ])('recognizes complete alternate and nested fences during streaming: %s', async (markdown) => {
    await render(markdown, true);
    expect(mocks.render, container.innerHTML).toHaveBeenCalledWith('flowchart LR\nA --> B\n', 'dark');
    expect(container.querySelector('[data-mermaid-view]')?.closest('pre')).toBeNull();
  });

  it('shows a failure for final invalid source and retains source copying', async () => {
    mocks.render.mockRejectedValueOnce(new Error('Invalid diagram syntax'));
    await render(fence('invalid diagram'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('无法渲染图表');
    expect(button('复制图片').disabled).toBe(true);
    await click('源码');
    await click('复制源码');
    expect(mocks.copyText).toHaveBeenCalledWith('invalid diagram\n');
  });

  it('discards an old source failure after the current render completes', async () => {
    const first = deferred<MermaidDiagram>();
    mocks.render.mockReturnValueOnce(first.promise);
    await render(fence('flowchart LR\nA --> B'));
    await render(fence('flowchart LR\nC --> D'));
    expect(renderedSvg()).toContain('C --> D');
    await act(async () => first.reject(new Error('Old syntax error')));
    expect(renderedSvg()).toContain('C --> D');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('rerenders for the resolved theme and ignores a previous theme response', async () => {
    const old = deferred<MermaidDiagram>();
    mocks.render.mockReturnValueOnce(old.promise);
    await render(fence('flowchart LR\nA --> B'));
    await act(async () => { document.documentElement.dataset.theme = 'light'; });
    expect(mocks.render).toHaveBeenLastCalledWith('flowchart LR\nA --> B\n', 'light');
    expect(renderedSvg()).toContain('light:');
    await act(async () => old.resolve(diagram('old dark diagram')));
    expect(renderedSvg()).toContain('light:');
  });

  it('keeps a single busy copy button across view/source changes and copies the clicked diagram', async () => {
    const pendingPng = deferred<Blob>();
    mocks.png.mockReturnValueOnce(pendingPng.promise);
    await render(fence('flowchart LR\nA --> B'));
    const clickedDiagram = mocks.render.mock.results[0]!.value;
    await click('复制图片');
    const copyButton = container.querySelector('[data-copy-status]');
    await click('源码');
    await render(fence('flowchart LR\nC --> D'));
    expect(container.querySelector('[data-copy-status]')).toBe(copyButton);
    expect(button('复制中…').disabled).toBe(true);
    expect(mocks.png).toHaveBeenCalledWith(await clickedDiagram);
    const png = new Blob(['first diagram'], { type: 'image/png' });
    await act(async () => pendingPng.resolve(png));
    expect(mocks.copyImage).toHaveBeenCalledWith({ kind: 'blob', blob: png, name: 'diagram.png' });
    expect(container.querySelector('[data-copy-status]')?.getAttribute('data-copy-status')).toBe('idle');
    await click('复制源码');
    expect(mocks.copyText).toHaveBeenCalledWith('flowchart LR\nC --> D\n');
  });

  it('does not apply old copy success to a different theme', async () => {
    const pendingCopy = deferred<void>();
    mocks.copyImage.mockReturnValueOnce(pendingCopy.promise);
    await render(fence('flowchart LR\nA --> B'));
    await click('复制图片');
    await act(async () => { document.documentElement.dataset.theme = 'light'; });
    await act(async () => pendingCopy.resolve());
    expect(container.querySelector('[data-copy-status]')?.getAttribute('data-copy-status')).toBe('idle');
  });

  it('retains ordinary code paths, raw HTML escaping and source line ranges', async () => {
    function SourceBlock({ startLine, endLine, children }: SourceBlockProps) {
      return createElement('section', { 'data-range': `${startLine}-${endLine}` }, children);
    }
    const markdown = [
      '# Example', '', '```mermaid', 'flowchart LR', 'A --> B', '```', '',
      '```text', '/workspace/example/source.ts', '```', '',
      '<script>window.bad = true</script>', '', '| Key | Value |', '| --- | --- |', '| One | **Ready** |',
    ].join('\n');
    await act(async () => root.render(createElement(LinkedMarkdown, {
      sourceBlocks: { startLine: 21, component: SourceBlock },
    }, markdown)));
    expect([...container.querySelectorAll('[data-range]')].map((node) => node.getAttribute('data-range')))
      .toEqual(['21-21', '23-26', '28-30', '32-32', '34-36']);
    expect(container.querySelector('[data-range="23-26"] [data-mermaid-view]')).not.toBeNull();
    expect(container.querySelector('pre [data-content-target="path"]')?.getAttribute('data-target'))
      .toBe('/workspace/example/source.ts');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>window.bad = true</script>');
    expect(container.querySelector('table strong')?.textContent).toBe('Ready');
  });

  it('renders multiple diagrams independently without treating ordinary or inline code as Mermaid', async () => {
    await render([fence('flowchart LR\nA --> B'), '`mermaid`', '```text\nmermaid\n```', fence('sequenceDiagram\nA->>B: Hello')].join('\n\n'));
    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('[data-mermaid-view]')).toHaveLength(2);
    expect([...container.querySelectorAll('code')].map((element) => element.textContent)).toEqual(['mermaid', 'mermaid\n']);
  });
});
