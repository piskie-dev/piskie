import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let StreamingMarkdown: typeof import('../StreamingMarkdown').StreamingMarkdown;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let dom: JSDOM;
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
  ({ StreamingMarkdown } = await import('../StreamingMarkdown'));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

afterAll(() => {
  if (previousCssLoader) nodeRequire.extensions['.css'] = previousCssLoader;
  else delete nodeRequire.extensions['.css'];
  dom.window.close();
  vi.unstubAllGlobals();
});

async function render(markdown: string, live: boolean): Promise<string> {
  if (!container) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(createElement(StreamingMarkdown, { markdown, live }));
  });
  return container.innerHTML;
}

describe('StreamingMarkdown', () => {
  it('renders every incomplete intermediate state and converges to static Markdown', async () => {
    const chunks = [
      '# 流式正文\n\n这是 **',
      '重点**、`inline code` 和 emoji 😀。\n\n- 第一项\n- 第',
      '二项\n\n[链接](https://example.com) 与 ![图片](https://example.com/a.png)\n\n```ts\nconst value = ',
      '1;\n```\n\n| 名称 | 值 |\n| --- | --- |\n| 缓存 | 95% |',
    ];
    let markdown = '';

    for (const chunk of chunks) {
      markdown += chunk;
      await expect(render(markdown, true)).resolves.toEqual(expect.any(String));
    }
    const liveHtml = container!.innerHTML;

    await act(async () => root!.unmount());
    container!.replaceChildren();
    root = createRoot(container!);
    const finalHtml = await render(markdown, false);

    expect(liveHtml).toBe(finalHtml);
    expect(finalHtml).toContain('<strong>重点</strong>');
    expect(finalHtml).toContain('<table>');
    expect(finalHtml).toContain('emoji 😀');
  });

  it('escapes raw HTML in both live and final rendering', async () => {
    const markdown = [
      '<strong>原始强调标签</strong> <code>raw.txt</code>',
      '',
      '<script>window.bad = true</script>',
      '',
      '**Markdown 强调**',
    ].join('\n');

    const liveHtml = await render(markdown, true);
    expect(liveHtml).not.toContain('<script>');
    expect(container!.textContent).toContain('<strong>原始强调标签</strong>');
    expect(container!.textContent).toContain('<code>raw.txt</code>');

    await act(async () => root!.unmount());
    container!.replaceChildren();
    root = createRoot(container!);
    const finalHtml = await render(markdown, false);

    expect(finalHtml).toBe(liveHtml);
    expect(finalHtml).not.toContain('<script>');
    expect(container!.querySelectorAll('strong')).toHaveLength(1);
    expect(container!.querySelector('strong')?.textContent).toBe('Markdown 强调');
    expect(container!.querySelector('code')).toBeNull();
  });

  it('preserves inline Markdown and path links inside loose list items', async () => {
    const markdown = [
      '- **主要条目**：`/workspace/example/page.html`',
      '  - **强调结果**',
      '',
      '- **普通条目**：/workspace/example/final image.png completed',
      '  - 已完成',
    ].join('\n');

    const html = await render(markdown, false);
    const targets = [...container!.querySelectorAll<HTMLElement>('[data-content-target="path"]')]
      .map((node) => node.dataset.target);

    expect(html).not.toContain('&lt;strong&gt;');
    expect(container!.querySelectorAll('strong')).toHaveLength(3);
    expect(container!.querySelector('code')?.textContent).toBe('/workspace/example/page.html');
    expect(targets).toEqual([
      '/workspace/example/page.html',
      '/workspace/example/final image.png',
    ]);
  });

  it('linkifies targets in prose, inline code, and fenced code', async () => {
    const markdown = [
      '正文路径 /home/user/project/report.txt 与 https://example.com/docs',
      '',
      '行内 `C:\\\\Work\\\\Piskie\\\\result.json`',
      '',
      '```text',
      '\\\\server\\share\\artifact.zip',
      '```',
    ].join('\n');

    await render(markdown, false);

    expect(container!.querySelectorAll('[data-content-target="url"]')).toHaveLength(1);
    expect(container!.querySelectorAll('[data-content-target="path"]')).toHaveLength(3);
  });
});
