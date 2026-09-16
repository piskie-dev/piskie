import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilePreviewDescriptor } from '@shared/electron-contracts/desktop';
import type { LinkedMarkdownProps } from '@/components/content-links/LinkedMarkdown';
import type { ImagePreviewHandler } from '@/components/image-preview/renderedImageContext';
import { ContentLinkUrlScope } from '@/components/content-links/ContentLinks';
import { retainFilePreviews } from '@/services/file-preview';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import { deferred } from '../../attachments/__tests__/fixtures';

let LinkedMarkdown: typeof import('@/components/content-links').LinkedMarkdown;
let ThreadCell: typeof import('../ThreadCell').ThreadCell;
let ReviewPanel: typeof import('../ReviewPanel').ReviewPanel;
let ImageThumbnail: typeof import('../ImageThumbnail').ImageThumbnail;
let ImageLightbox: typeof import('../ImageLightbox').default;
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const nodeRequire = createRequire(import.meta.url);
const previousCssLoader = nodeRequire.extensions['.css'];
const preview = vi.fn<(path: string) => Promise<FilePreviewDescriptor>>();
const releasePreview = vi.fn(async (_url: string) => undefined);
const onOpenLocalFile = vi.fn();
const onOpenUrl = vi.fn();
let token = 0;
function image(): FilePreviewDescriptor {
  return { kind: 'image', url: `piskie-attachment://preview/sample-${++token}`, mediaType: 'image/png', size: 4 };
}
const markdownImage = (src: string) => `![Sample illustration](<${src.replace(/\\/g, '\\\\')}>)`;

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://renderer.example.test' });
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DOMParser', 'MutationObserver'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'showModal', {
    configurable: true, value() { this.setAttribute('open', ''); },
  });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'close', {
    configurable: true, value() { this.removeAttribute('open'); },
  });
  Object.assign(dom.window, { piskie: { desktop: {
    files: { preview, releasePreview }, system: { platform: 'linux' },
  } } });
  nodeRequire.extensions['.css'] = () => undefined;
  ({ LinkedMarkdown } = await import('@/components/content-links'));
  ({ ThreadCell } = await import('../ThreadCell'));
  ({ ReviewPanel } = await import('../ReviewPanel'));
  ({ ImageThumbnail } = await import('../ImageThumbnail'));
  ({ default: ImageLightbox } = await import('../ImageLightbox'));
});
beforeEach(() => {
  token = 0;
  preview.mockReset().mockImplementation(async () => image());
  releasePreview.mockClear();
  onOpenLocalFile.mockReset();
  onOpenUrl.mockReset();
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

async function render(content: string, props: Omit<LinkedMarkdownProps, 'children'> = {}) {
  await act(async () => root.render(createElement(ContentLinkUrlScope,
    { onOpenLocalFile, onOpenUrl }, createElement(LinkedMarkdown, props, content))));
}
async function loadImages() {
  await act(async () => {
    for (const element of container.querySelectorAll('img')) element.dispatchEvent(new dom.window.Event('load'));
  });
}

describe('Markdown image sources and failures', () => {
  it.each([
    { src: '/workspace/assets/sample 图.png', path: '/workspace/assets/sample 图.png' },
    { src: '/workspace/assets/sample%20%E5%9B%BE.png', path: '/workspace/assets/sample 图.png' },
    { src: '/workspace/assets/100% sample.png', path: '/workspace/assets/100% sample.png' },
    { src: 'file:///workspace/assets/sample%20%E5%9B%BE.png', path: '/workspace/assets/sample 图.png' },
    { src: 'file:///workspace/assets/literal%2520.png', path: '/workspace/assets/literal%20.png' },
    { src: 'C:\\Sample Folder\\图.png', path: 'C:\\Sample Folder\\图.png' },
    { src: 'C:/Sample Folder/图.png', path: 'C:/Sample Folder/图.png' },
    { src: 'file:///C:/Sample%20Folder/%E5%9B%BE.png', path: 'C:/Sample Folder/图.png' },
    { src: '\\\\files.example.test\\share\\sample 图.png', path: '\\\\files.example.test\\share\\sample 图.png' },
    { src: 'file://files.example.test/share/sample%20%E5%9B%BE.png', path: '//files.example.test/share/sample 图.png' },
    { src: './assets/../sample%20%E5%9B%BE.png', baseDirectory: '/workspace/project', path: '/workspace/project/sample 图.png' },
    { src: '../sample.png', baseDirectory: 'C:\\Example\\docs', path: 'C:\\Example\\sample.png' },
    { src: '..\\sample.png', baseDirectory: '\\\\files.example.test\\share\\docs', path: '\\\\files.example.test\\share\\sample.png' },
  ])('previews $src through the local protocol and releases it on unmount', async ({ src, baseDirectory, path }) => {
    await render(markdownImage(src), { baseDirectory });
    expect(preview).toHaveBeenCalledExactlyOnceWith(path);
    const element = container.querySelector('img')!;
    expect(element.getAttribute('src')).toBe('piskie-attachment://preview/sample-1');
    expect(element.hidden).toBe(true);
    expect(container.textContent).toContain('图片加载中');
    await loadImages();
    expect(element.hidden).toBe(false);
    expect(element.alt).toBe('Sample illustration');
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.render(null));
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith('piskie-attachment://preview/sample-1');
  });

  it.each(['http://images.example.test/sample.png', 'https://images.example.test/sample%20image.png?a=1&b=2'])('displays %s directly and gives a link after a load error', async (src) => {
    await render(markdownImage(src));
    expect(preview).not.toHaveBeenCalled();
    const element = container.querySelector('img')!;
    expect(element.getAttribute('src')).toBe(src);
    await loadImages();
    expect(element.hidden).toBe(false);
    await act(async () => element.dispatchEvent(new dom.window.Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('图片加载失败 · Sample illustration');
    await act(async () => container.querySelector<HTMLAnchorElement>('[data-content-target="url"]')!.click());
    expect(onOpenUrl).toHaveBeenCalledWith(src);
    expect(releasePreview).not.toHaveBeenCalled();
  });

  it('waits for the file service, then replaces a rejected preview with an actionable file link', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    preview.mockReturnValueOnce(pending.promise);
    await render(markdownImage('assets/sample.png'), { baseDirectory: '/workspace/project' });
    expect(container.textContent).toContain('图片加载中');
    expect(container.querySelector('img')).toBeNull();
    await act(async () => pending.reject(new Error('Example missing file')));
    expect(container.textContent).toContain('图片加载失败 · Sample illustration');
    expect(container.textContent).toContain('/workspace/project/assets/sample.png');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-content-target="path"]')!.click());
    expect(onOpenLocalFile).toHaveBeenCalledWith('/workspace/project/assets/sample.png');
  });

  it.each(['file', 'decode'] as const)('removes the image and preserves its description and path on a %s failure', async (failure) => {
    if (failure === 'file') preview.mockResolvedValueOnce({ kind: 'file', mediaType: 'application/octet-stream', size: 4 });
    await render(markdownImage('/workspace/sample.png'));
    if (failure === 'decode') {
      await act(async () => container.querySelector('img')!.dispatchEvent(new dom.window.Event('error')));
    }
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('图片加载失败 · Sample illustration');
    expect(container.querySelector('[data-target]')?.getAttribute('data-target')).toBe('/workspace/sample.png');
    await act(async () => root.render(null));
    expect(releasePreview).toHaveBeenCalledTimes(failure === 'decode' ? 1 : 0);
  });

  it('requires an explicit base for relative images instead of using the renderer origin', async () => {
    await render(markdownImage('assets/sample.png'));
    expect(preview).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('图片加载失败');
    expect(container.textContent).toContain('assets/sample.png');
    await render(markdownImage('assets/sample.png'), { baseDirectory: '/workspace/project' });
    expect(preview).toHaveBeenCalledExactlyOnceWith('/workspace/project/assets/sample.png');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('piskie-attachment://preview/sample-1');
  });

  it.each(['javascript:alert(1)', 'data:image/svg+xml,example'])('does not load an unsupported image scheme: %s', async (src) => {
    await render(markdownImage(src));
    expect(preview).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-content-target]')).toBeNull();
    expect(container.textContent).toContain('图片加载失败');
  });

  it('resets a failed network source on replacement and can display that source again', async () => {
    const first = 'https://images.example.test/first.png';
    await render(markdownImage(first));
    await act(async () => container.querySelector('img')!.dispatchEvent(new dom.window.Event('error')));
    await render(markdownImage('https://images.example.test/second.png'));
    expect(container.textContent).toContain('图片加载中');
    await render(markdownImage(first));
    await loadImages();
    expect(container.querySelector('img')?.hidden).toBe(false);
  });

  it('releases a token returned after its Markdown has unmounted', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    preview.mockReturnValueOnce(pending.promise);
    await render(markdownImage('/workspace/sample.png'));
    await act(async () => root.render(null));
    await act(async () => pending.resolve(image()));
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith('piskie-attachment://preview/sample-1');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('conversation and document image preview', () => {
  it('uses the conversation workspace through ThreadCell and preserves a loaded image during streaming', async () => {
    const onPreviewImage = vi.fn();
    for (const [text, live] of [[markdownImage('assets/sample.png'), true], [markdownImage('assets/sample.png') + '\n\nNext paragraph.', false]] as const) {
      const [cell] = projectConversationNodes([{ t: 'msg', role: 'assistant', id: 'sample-message', ts: 1, content: text }]);
      if (!cell || cell.kind !== 'assistant') throw new Error('Expected sample assistant content');
      await act(async () => root.render(createElement(ThreadCell, { cell: { ...cell, live }, workspace: '/workspace/session', onPreviewImage })));
      await loadImages();
    }
    expect(preview).toHaveBeenCalledExactlyOnceWith('/workspace/session/assets/sample.png');
    await act(async () => container.querySelector('img')!.click());
    expect(onPreviewImage).toHaveBeenCalledWith('piskie-attachment://preview/sample-1', ['piskie-attachment://preview/sample-1'], 0);
  });

  it.each((['read', 'preview'] as const).flatMap((mode) => [
    { mode, path: '/workspace/documents/nested/sample.md', imagePath: '/workspace/documents/assets/sample.png' },
    { mode, path: '/sample.md', imagePath: '/assets/sample.png' },
    { mode, path: 'C:\\Documents\\nested\\sample.md', imagePath: 'C:\\Documents\\assets\\sample.png' },
    { mode, path: 'C:\\sample.md', imagePath: 'C:\\assets\\sample.png' },
    { mode, path: '\\\\files.example.test\\share\\nested\\sample.md', imagePath: '\\\\files.example.test\\share\\assets\\sample.png' },
  ]))('resolves images relative to $path in a $mode panel and preserves source lines', async ({ mode, path, imagePath }) => {
    const onPreviewImage = vi.fn();
    const content = markdownImage('../assets/sample.png') + '\n\n' + markdownImage('https://images.example.test/other.png');
    await act(async () => root.render(createElement(ReviewPanel, {
      change: null,
      read: mode === 'read' ? { kind: 'read', path, content, startLine: 21 } : null,
      preview: mode === 'preview' ? { path, descriptor: { kind: 'text', content, truncated: false, size: 4 } } : null,
      onOpenPath: vi.fn(), onRevealPath: vi.fn(), onPreviewImage,
    })));
    expect(preview).toHaveBeenCalledExactlyOnceWith(imagePath);
    expect([...container.querySelectorAll('[class*="sourceLineNo"]')].map((node) => node.textContent))
      .toEqual(mode === 'read' ? ['21', '23'] : ['1', '3']);
    await loadImages();
    await act(async () => container.querySelectorAll('img')[1]!.click());
    expect(onPreviewImage).toHaveBeenCalledWith('https://images.example.test/other.png', [
      'piskie-attachment://preview/sample-1', 'https://images.example.test/other.png',
    ], 1);
  });

  it('shares the gallery with attachments and keeps local tokens alive until the lightbox closes', async () => {
    function Gallery({ showContent }: { showContent: boolean }) {
      const [selection, setSelection] = useState<{ urls: readonly string[]; index: number } | null>(null);
      const release = useRef<(() => void) | undefined>();
      useEffect(() => () => release.current?.(), []);
      const open: ImagePreviewHandler = (_url, urls = [_url], index = 0) => {
        const retained = retainFilePreviews(urls);
        release.current?.();
        release.current = retained;
        setSelection({ urls, index });
      };
      return createElement('div', null,
        showContent && createElement('div', { 'data-image-preview-scope': true },
          createElement(ImageThumbnail, { resource: { kind: 'file', path: '/workspace/attachment.png' }, alt: 'Sample attachment', onPreview: open }),
          createElement(LinkedMarkdown, { onPreviewImage: open }, markdownImage('/workspace/body.png')),
          createElement(LinkedMarkdown, { onPreviewImage: open }, markdownImage('https://images.example.test/pending.png'))),
        createElement(ImageLightbox, { preview: selection, onClose: () => { release.current?.(); setSelection(null); } }));
    }
    await act(async () => root.render(createElement(Gallery, { showContent: true })));
    const images = [...container.querySelectorAll('img')];
    await act(async () => images[1]!.dispatchEvent(new dom.window.Event('load')));
    await act(async () => images[1]!.parentElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(container.querySelector('dialog[open]')).not.toBeNull();
    const picture = () => container.querySelector('dialog img[alt^="第"]');
    expect(picture()?.getAttribute('src')).toBe('piskie-attachment://preview/sample-2');
    const currentCounter = () => container.querySelector('dialog [aria-label="当前会话中的图片"] [aria-live="polite"]')?.textContent;
    expect(currentCounter()).toBe('2 / 2');
    await act(async () => root.render(createElement(Gallery, { showContent: false })));
    expect(releasePreview).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="上一张图片"]')!.click());
    expect(picture()?.getAttribute('src')).toBe('piskie-attachment://preview/sample-1');
    expect(currentCounter()).toBe('1 / 2');
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="关闭预览"]')!.click());
    expect(releasePreview.mock.calls.map(([url]) => url).sort()).toEqual([
      'piskie-attachment://preview/sample-1', 'piskie-attachment://preview/sample-2',
    ]);
  });
});
