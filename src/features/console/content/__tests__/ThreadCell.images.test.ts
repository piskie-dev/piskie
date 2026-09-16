import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationEntry } from '../../../../../shared/types';
import { projectConversationNodes } from '@/domains/transcript/project-entry';

vi.mock('@/components/content-links', () => ({
  LinkedMarkdown: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  LinkedText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../StreamingMarkdown', () => ({ StreamingMarkdown: () => null }));

const preview = vi.fn(async (sourcePath: string) => ({
  kind: 'image' as const,
  url: `piskie-attachment://preview/${sourcePath.split('/').at(-1)}`,
  mediaType: 'image/png',
  size: 1,
}));
const releasePreview = vi.fn(async (_url: string) => undefined);
const openPath = vi.fn(async (_path: string) => undefined);

let root: Root;
let container: HTMLDivElement;
let dom: JSDOM;
let ThreadCell: typeof import('../ThreadCell').ThreadCell;

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const expose = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose('window', dom.window);
  expose('document', dom.window.document);
  expose('navigator', dom.window.navigator);
  expose('HTMLElement', dom.window.HTMLElement);
  expose('Node', dom.window.Node);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  preview.mockClear();
  releasePreview.mockClear();
  openPath.mockReset();
  Object.defineProperty(window, 'piskie', {
    configurable: true,
    value: { desktop: { files: { preview, releasePreview }, system: { platform: 'linux', openPath } } },
  });
  ({ ThreadCell } = await import('../ThreadCell'));
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  // 每个已展示的缩略图卸载时都要归还主进程的预览令牌。
  const shown = [...new Set((await Promise.all(preview.mock.results.map((result) => result.value))).map((value) => value.url))];
  expect(releasePreview.mock.calls.map(([url]) => url).sort()).toEqual(shown.sort());
  dom.window.close();
});

describe('ThreadCell canonical image refs', () => {
  it.each(['', '  Inspect the sample\nwith its original spacing.  '])('renders file chips beside images and preserves body %j', async (text) => {
    const files = [{ name: 'A long sample attachment name with spaces.zip', path: '/workspace/sample/archive.zip' }] as const;
    const [cell] = projectConversationNodes([{
      t: 'msg', role: 'user', subtype: 'user_input', id: 'sample-attachments', ts: 1,
      metadata: { userInput: { text, files } },
      content: [
        { type: 'text', text: `${text}\n\nAttached model paths: ${files[0].path}` },
        { type: 'image_ref', path: '/workspace/sample/image.png', size: 1, mediaType: 'image/png' },
      ],
    }]);
    if (!cell) throw new Error('Expected a sample message');
    const onPreviewImage = vi.fn();
    await act(async () => root.render(createElement(ThreadCell, { cell, onPreviewImage })));
    expect(container.textContent).toBe(`${text}${files[0].name}`);
    const chip = container.querySelector<HTMLButtonElement>('button[title="/workspace/sample/archive.zip"]')!;
    expect(chip.type).toBe('button');
    expect(chip.tabIndex).toBe(0);
    expect(chip.textContent).toBe(files[0].name);
    expect(chip.querySelector('.lucide-file-text')).not.toBeNull();
    await act(async () => chip.click());
    expect(openPath).toHaveBeenCalledExactlyOnceWith(files[0].path);
    container.querySelector('img')!.click();
    expect(onPreviewImage).toHaveBeenCalledWith('piskie-attachment://preview/image.png', expect.any(Array), 0);
  });

  it('renders a sent directory with a folder icon and opens its path', async () => {
    const file = { name: 'sample folder.png', path: '/sample workspace/sample folder.png', kind: 'directory' } as const;
    const [cell] = projectConversationNodes([{
      t: 'msg', role: 'user', subtype: 'user_input', id: 'sample-directory', ts: 1, content: 'Sample message',
      metadata: { userInput: { text: '', files: [file] } },
    }]);
    if (!cell) throw new Error('Expected a sample message');
    await act(async () => root.render(createElement(ThreadCell, { cell })));
    const chip = container.querySelector<HTMLButtonElement>('button[title="/sample workspace/sample folder.png"]')!;
    expect(chip.textContent).toBe(file.name);
    expect(chip.querySelector('.lucide-folder-open')).not.toBeNull();
    await act(async () => chip.click());
    expect(openPath).toHaveBeenCalledExactlyOnceWith(file.path);
  });

  it('keeps a paired question file visible and opens it with the same file action', async () => {
    const files = [{ name: 'sample.csv', path: '/workspace/sample.csv' }];
    const cells = projectConversationNodes([
      { t: 'msg', role: 'assistant', id: 'sample-question', ts: 1, content: [{
        type: 'tool_use', id: 'sample-call', name: 'ask_user', input: { questions: [{ question: 'Sample choice?' }] },
      }] },
      { t: 'tool', toolUseId: 'sample-call', ts: 2, ok: true, metadata: { userInput: { text: 'Sample answer', files } },
        result: [{ type: 'text', text: 'Sample answer\n\nModel path: /workspace/sample.csv' }],
        artifacts: [{ kind: 'ask_user_answers', payload: { answers: ['Sample answer'] } }],
      },
    ]);
    const cell = cells.find((node) => node.kind === 'tool')!;
    await act(async () => root.render(createElement(ThreadCell, { cell })));
    const chip = container.querySelector<HTMLButtonElement>('button[title="/workspace/sample.csv"]')!;
    expect(chip.textContent).toBe('sample.csv');
    expect(container.textContent).not.toContain('/workspace/sample.csv');
    await act(async () => chip.click());
    expect(openPath).toHaveBeenCalledWith('/workspace/sample.csv');
  });

  it('delegates repeated file clicks to the desktop while keeping the attachment message stable', async () => {
    const [cell] = projectConversationNodes([{
      t: 'msg', role: 'user', subtype: 'user_input', id: 'sample-file', ts: 1, content: 'Model path',
      metadata: { userInput: { text: '', files: [{ name: 'sample.bin', path: '/workspace/sample.bin' }] } },
    }]);
    if (!cell) throw new Error('Expected a sample message');
    openPath.mockRejectedValueOnce(new Error('Sample file unavailable'));
    await act(async () => root.render(createElement(ThreadCell, { cell })));
    const chip = container.querySelector<HTMLButtonElement>('button')!;
    await act(async () => chip.click());
    expect(container.textContent).toBe('sample.bin');
    await act(async () => chip.click());
    expect(openPath.mock.calls).toEqual([['/workspace/sample.bin'], ['/workspace/sample.bin']]);
    expect(container.textContent).toBe('sample.bin');
  });

  it.each(['browser', 'parent'])('preserves %s event images in the expandable message body', async (source) => {
    const entries: ConversationEntry[] = [{
      t: 'msg', ts: 1, id: 'sample-automatic-image', role: 'user', subtype: 'system_event',
      content: [
        { type: 'text', text: `<agent_input source="${source}"></agent_input>` },
        { type: 'image_ref', path: '/workspace/sample-notice.png', size: 1, mediaType: 'image/png' },
      ],
    }];
    const [cell] = projectConversationNodes(entries);
    if (!cell) throw new Error('Expected an automatic message');
    expect(cell.interaction).toBe('expand');
    if (!cell) throw new Error('Expected a sample message');
    const onPreviewImage = vi.fn();
    await act(async () => root.render(createElement(ThreadCell, { cell, onPreviewImage })));
    expect(container.querySelector('img')).toBeNull();
    expect(preview).not.toHaveBeenCalled();

    const toggle = container.querySelector<HTMLButtonElement>('[data-flow-event] > button');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle?.click());
    expect(preview).toHaveBeenCalledWith('/workspace/sample-notice.png');
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('piskie-attachment://preview/sample-notice.png');
    image?.click();
    expect(onPreviewImage).toHaveBeenCalled();
  });

  it('projects and renders three independent streamed thumbnails in block order', async () => {
    const imageRef = (name: string) => ({
      type: 'image_ref' as const,
      path: `/agent/blobs/${name}.png`,
      size: 1,
      mediaType: 'image/png',
    });
    const entries: ConversationEntry[] = [{
      t: 'msg',
      ts: 1,
      id: 'user-three-images',
      role: 'user',
      subtype: 'user_input',
      content: [imageRef('one'), imageRef('two'), imageRef('one'), { type: 'text', text: 'look' }],
    }];
    const [cell] = projectConversationNodes(entries);
    if (!cell || cell.kind !== 'user') throw new Error('user cell missing');
    expect(cell.images?.map((image) => image.kind === 'file' ? image.path : image.url)).toEqual([
      '/agent/blobs/one.png',
      '/agent/blobs/two.png',
      '/agent/blobs/one.png',
    ]);

    await act(async () => {
      root.render(createElement(ThreadCell, { cell }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(preview.mock.calls.map(([sourcePath]) => sourcePath)).toEqual([
      '/agent/blobs/one.png',
      '/agent/blobs/two.png',
      '/agent/blobs/one.png',
    ]);
    expect([...container.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      'piskie-attachment://preview/one.png',
      'piskie-attachment://preview/two.png',
      'piskie-attachment://preview/one.png',
    ]);
    expect(container.innerHTML).not.toContain('file://');
  });

  it('renders MCP/tool result image refs through the same streamed thumbnail path', async () => {
    const entries: ConversationEntry[] = [
      {
        t: 'msg',
        ts: 1,
        id: 'assistant-mcp-image',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'mcp-image-call',
          name: 'mcp__charts__render',
          input: {},
        }],
      },
      {
        t: 'tool',
        ts: 2,
        toolUseId: 'mcp-image-call',
        ok: true,
        result: [
          { type: 'text', text: 'chart attached' },
          {
            type: 'image_ref',
            path: '/agent/blobs/mcp-chart.png',
            size: 5,
            mediaType: 'image/png',
          },
        ],
      },
    ];
    const [cell] = projectConversationNodes(entries);
    if (!cell || cell.kind !== 'tool') throw new Error('MCP tool cell missing');
    expect(cell.media).toEqual([{ kind: 'file', path: '/agent/blobs/mcp-chart.png' }]);

    await act(async () => {
      root.render(createElement(ThreadCell, { cell }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(preview).toHaveBeenCalledWith('/agent/blobs/mcp-chart.png');
    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('piskie-attachment://preview/mcp-chart.png');
    expect(container.innerHTML).not.toContain('file://');
  });

  it('opens every rendered image in the surrounding transcript order', async () => {
    const entries: ConversationEntry[] = [{
      t: 'msg',
      ts: 1,
      id: 'user-context-image',
      role: 'user',
      subtype: 'user_input',
      content: [{
        type: 'image_ref',
        path: '/agent/blobs/context.png',
        size: 1,
        mediaType: 'image/png',
      }],
    }];
    const [cell] = projectConversationNodes(entries);
    if (!cell || cell.kind !== 'user') throw new Error('user cell missing');
    const onPreviewImage = vi.fn();

    await act(async () => {
      root.render(createElement(
        'div',
        { 'data-image-preview-scope': true },
        createElement('img', { src: 'https://example.test/before.png', alt: 'before' }),
        createElement(ThreadCell, { cell, onPreviewImage }),
        createElement('img', { src: 'https://example.test/after.png', alt: 'after' }),
      ));
      await Promise.resolve();
      await Promise.resolve();
    });

    const clicked = container.querySelector<HTMLImageElement>(
      'img[src="piskie-attachment://preview/context.png"]',
    );
    expect(clicked).not.toBeNull();
    clicked?.click();

    expect(onPreviewImage).toHaveBeenCalledWith(
      'piskie-attachment://preview/context.png',
      [
        'https://example.test/before.png',
        'piskie-attachment://preview/context.png',
        'https://example.test/after.png',
      ],
      1,
    );
  });
});
