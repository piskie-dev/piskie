import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopyImageRequest } from '@shared/electron-contracts/desktop';
import type { MermaidDiagram } from '../mermaidRuntime';
import { deferred, pngBytes } from '@/features/console/attachments/__tests__/fixtures';
import ImageLightbox from '@/features/console/content/ImageLightbox';
import { useConsoleShell, type ConsoleShell } from '@/features/console/shell/useConsoleShell';

const runtime = vi.hoisted(() => ({ agentRuns: { refresh: vi.fn(async () => undefined) } }));
const mocks = vi.hoisted(() => ({
  render: vi.fn<(source: string, theme: string) => Promise<MermaidDiagram>>(),
  png: vi.fn<() => Promise<Blob>>(),
}));
vi.mock('../mermaidRuntime', () => ({ renderMermaid: mocks.render, mermaidToPng: mocks.png }));
vi.mock('@/renderer-runtime/hooks', () => ({
  useRendererRuntime: () => runtime,
  useAgentControl: (select: (state: { agentsById: Record<string, never> }) => unknown) => select({ agentsById: {} }),
  useAgentRunPreview: (select: (state: { state: null }) => unknown) => select({ state: null }),
}));
vi.mock('@/features/console/data/session', () => ({ useHistoryRows: () => [], useSessionRows: () => [] }));
vi.mock('@/features/console/data/actions', () => ({ useConsoleActions: () => ({ loadHistory: vi.fn() }) }));

let LinkedMarkdown: typeof import('../LinkedMarkdown').LinkedMarkdown;
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let shell: ConsoleShell;
const nodeRequire = createRequire(import.meta.url);
const previousCssLoader = nodeRequire.extensions['.css'];
const publish = vi.fn<(request: CopyImageRequest) => Promise<void>>();
const source = 'flowchart TB\nA[Sample start] --> B[Sample finish]\n';
const png = new Blob([pngBytes(620, 2400)], { type: 'image/png' });

function Harness({ showContent = true, content = source }: { showContent?: boolean; content?: string }) {
  const current = useConsoleShell();
  useLayoutEffect(() => { shell = current; });
  return createElement('div', null,
    showContent && createElement(LinkedMarkdown, { onPreviewImage: current.setPreviewImage }, `\`\`\`mermaid\n${content}\`\`\``),
    createElement(ImageLightbox, { preview: current.previewImage, onClose: () => current.setPreviewImage(null) }));
}

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DOMParser', 'MutationObserver'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.assign(window, { piskie: { desktop: { files: { copyImage: publish } } } });
  nodeRequire.extensions['.css'] = () => undefined;
  ({ LinkedMarkdown } = await import('../LinkedMarkdown'));
});
beforeEach(() => {
  document.documentElement.dataset.theme = 'light';
  mocks.render.mockReset().mockImplementation(async (text) => ({
    svg: `<svg width="310" height="1200" viewBox="0 0 310 1200"><text>${text}</text></svg>`, width: 310, height: 1200,
  }));
  mocks.png.mockReset().mockResolvedValue(png);
  publish.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (previousCssLoader) nodeRequire.extensions['.css'] = previousCssLoader;
  else delete nodeRequire.extensions['.css'];
  dom.window.close();
  vi.unstubAllGlobals();
});

async function render(props: { showContent?: boolean; content?: string } = {}) {
  await act(async () => root.render(createElement(Harness, props)));
}
const trigger = () => container.querySelector<HTMLElement>('[data-mermaid-view] [role="button"]')!;
const picture = () => container.querySelector<HTMLImageElement>('dialog img')!;
const click = (element: HTMLElement) => act(async () => element.click());
const close = () => act(async () => shell.setPreviewImage(null));

async function copyPreview() {
  const expectedCalls = publish.mock.calls.length + 1;
  await act(async () => {
    container.querySelector<HTMLButtonElement>('dialog [data-copy-status]')!.click();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(expectedCalls));
  });
}

describe('Mermaid preview through the existing console shell', () => {
  it('generates PNG on demand, survives Markdown unmount and copies every byte even when closed during publication', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const pending = deferred<void>();
    publish.mockReturnValueOnce(pending.promise);
    await render();
    expect(mocks.png).not.toHaveBeenCalled();
    await click(trigger());
    expect(container.querySelector('dialog[open]')).not.toBeNull();
    expect(shell.previewImage).toMatchObject({ urls: [picture().src], index: 0, name: 'diagram.png' });
    expect(container.querySelector('dialog [aria-label="下一张图片"]')).toBeNull();
    const url = picture().src;
    expect(await (await fetch(url)).blob()).toMatchObject({ type: 'image/png', size: png.size });
    expect(mocks.png).toHaveBeenCalledExactlyOnceWith(await mocks.render.mock.results[0]!.value);
    await render({ showContent: false });
    expect(revoke).not.toHaveBeenCalledWith(url);
    await copyPreview();
    expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'bytes', bytes: await png.arrayBuffer(), name: 'diagram.png' });
    await close();
    expect(revoke.mock.calls.filter(([value]) => value === url)).toHaveLength(1);
    await act(async () => pending.resolve());
    expect(container.querySelector('dialog[open]')).toBeNull();
  });

  it('opens with the keyboard, releases a replaced preview and releases the active URL when the shell unmounts', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await render();
    await act(async () => trigger().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const first = picture().src;
    await render({ content: 'flowchart LR\nC[Example] --> D[Complete]\n' });
    expect(revoke).not.toHaveBeenCalledWith(first);
    await act(async () => trigger().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    const second = picture().src;
    expect(second).not.toBe(first);
    expect(revoke.mock.calls.filter(([value]) => value === first)).toHaveLength(1);
    expect(revoke).not.toHaveBeenCalledWith(second);
    await act(async () => root.render(null));
    expect(revoke.mock.calls.filter(([value]) => value === second)).toHaveLength(1);
  });

  it('keeps one pending preview request and allows retry after a conversion failure', async () => {
    const pending = deferred<Blob>();
    mocks.png.mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { trigger().click(); trigger().click(); });
    expect(mocks.png).toHaveBeenCalledOnce();
    expect(trigger().getAttribute('aria-busy')).toBe('true');
    await act(async () => pending.reject(new Error('PNG encoding unavailable')));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('图片加载失败');
    expect(trigger().hasAttribute('aria-busy')).toBe(false);
    await click(trigger());
    expect(container.querySelector('dialog[open]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.png).toHaveBeenCalledTimes(2);
  });

  it.each(['source', 'theme', 'view', 'unmount'] as const)('does not open a stale preview or allocate its URL after %s changes', async (change) => {
    const pending = deferred<Blob>();
    mocks.png.mockReturnValueOnce(pending.promise);
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    await render();
    await click(trigger());
    if (change === 'source') await render({ content: 'flowchart LR\nC --> D\n' });
    else if (change === 'theme') await act(async () => { document.documentElement.dataset.theme = 'dark'; });
    else if (change === 'view') await click(container.querySelector<HTMLButtonElement>('[data-mermaid-view] button[aria-pressed="false"]')!);
    else await render({ showContent: false });
    await act(async () => pending.resolve(png));
    expect(createUrl).not.toHaveBeenCalled();
    expect(shell.previewImage).toBeNull();
    if (change === 'view') {
      await click(container.querySelector<HTMLButtonElement>('[data-mermaid-view] button[aria-pressed="false"]')!);
      await click(trigger());
      expect(container.querySelector('dialog[open]')).not.toBeNull();
    }
  });
});
