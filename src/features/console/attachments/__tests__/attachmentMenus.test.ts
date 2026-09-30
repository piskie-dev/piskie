import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { Element as HtmlElement } from 'html-react-parser';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, copyImage, copyText } from '@/services/clipboard';
import { useToastStore } from '@/features/toasts';
import { clearFilePreviews } from '@/services/file-preview';
import { resetShortcutRegistry } from '@/shortcuts';
import { MarkdownImage } from '@/components/content-links/MarkdownImage';
import { MarkdownImageContext } from '@/components/content-links/markdownImageContext';
import { FileAttachments } from '../../content/FileAttachments';
import { ImageThumbnail } from '../../content/ImageThumbnail';
import { ImageReview } from '../../content/ImageReview';
import ImageLightbox from '../../content/ImageLightbox';
import { GateAttachments } from '../../content/gates/parts';
import { clearAllComposerDrafts, useComposerDraftStore } from '../../data/composer-drafts';
import type { ReadyAttachmentImage } from '../model';
import { deferred } from './fixtures';
import { installMenuDom, menuLabels, rightClick, selectMenuItem } from './menuTestDom';

vi.mock('@/services/clipboard', () => ({ copyFile: vi.fn(), copyImage: vi.fn(), copyText: vi.fn() }));
vi.mock('../thumbnail', () => ({ createImageThumbnail: async (blob: Blob) => blob }));

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const openPath = vi.fn();
const revealPath = vi.fn();
const previewFile = vi.fn(async (path: string) => ({ kind: 'image', revision: 'sample-revision',
  url: `piskie-attachment://preview/${encodeURIComponent(path)}`, mediaType: 'image/png', size: 4 }));
const draftImage: ReadyAttachmentImage = { id: 'sample-image', status: 'ready', name: 'sample.png', blob: new Blob(['sample'], { type: 'image/png' }) };

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  installMenuDom(dom);
  await i18n.changeLanguage('en-US');
  vi.mocked(copyFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(copyImage).mockReset().mockResolvedValue(undefined);
  vi.mocked(copyText).mockReset().mockResolvedValue(undefined);
  openPath.mockReset().mockResolvedValue(undefined);
  revealPath.mockReset().mockResolvedValue(undefined);
  previewFile.mockClear();
  useToastStore.setState({ toasts: [] });
  Object.assign(window, { piskie: { desktop: { files: { preview: previewFile, releasePreview: async () => undefined },
    system: { platform: 'linux', openPath, revealPath } } } });
  clearAllComposerDrafts();
  useComposerDraftStore.setState({ drafts: { sample: { text: '', edit: {}, skills: [], browserEnvironmentIds: [],
    attachments: { images: [draftImage], files: [] } } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearFilePreviews();
  clearAllComposerDrafts();
  resetShortcutRegistry();
  container.remove();
  dom.window.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = async (element: React.ReactNode) => { await act(async () => root.render(element)); };
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const toast = () => useToastStore.getState().toasts.at(-1);

describe('attachment context actions', () => {
  it('targets the clicked file/folder, preserves left-click open, and waits for copy completion', async () => {
    const files = [{ name: 'notes.txt', path: '/workspace/notes.txt' }, { name: 'assets', path: '/workspace/assets', kind: 'directory' as const }];
    await render(createElement(FileAttachments, { files }));
    const [file, folder] = [...container.querySelectorAll('button')];
    await rightClick(folder!);
    expect(openPath).not.toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled();
    expect(previewFile).not.toHaveBeenCalled();
    expect(menuLabels(container)).toEqual(['Open folder', 'Copy folder', 'Copy path', 'Show in file manager']);
    const pending = deferred<void>();
    vi.mocked(copyFile).mockReturnValueOnce(pending.promise);
    await selectMenuItem(container, 'Copy folder');
    expect(copyFile).toHaveBeenCalledExactlyOnceWith(files[1]!.path);
    expect(toast()).toBeUndefined();
    await act(async () => pending.resolve());
    expect(toast()?.title).toBe('Folder copied');
    await rightClick(file!);
    await selectMenuItem(container, 'Copy path');
    expect(copyText).toHaveBeenLastCalledWith(files[0]!.path);
    await rightClick(folder!);
    await selectMenuItem(container, 'Show in file manager');
    expect(revealPath).toHaveBeenCalledExactlyOnceWith(files[1]!.path);
    await click(file!);
    expect(openPath).toHaveBeenCalledExactlyOnceWith(files[0]!.path);
    await rightClick(file!);
    await selectMenuItem(container, 'Open file');
    expect(openPath).toHaveBeenLastCalledWith(files[0]!.path);
  });

  it('copies local image contents and original file references separately and reuses preview', async () => {
    const path = '/workspace/picture.png';
    const preview = vi.fn();
    await render(createElement(ImageThumbnail, { resource: { kind: 'file', path }, alt: 'Sample picture', onPreview: preview }));
    const image = container.querySelector('img')!;
    previewFile.mockClear();
    await rightClick(image);
    expect(preview).not.toHaveBeenCalled();
    expect(previewFile).not.toHaveBeenCalled();
    expect(copyImage).not.toHaveBeenCalled();
    expect(menuLabels(container)).toEqual(['Preview image', 'Copy image', 'Copy file', 'Copy path', 'Show in file manager']);
    await selectMenuItem(container, 'Copy image');
    expect(copyImage).toHaveBeenLastCalledWith({ kind: 'path', path });
    await rightClick(image);
    await selectMenuItem(container, 'Copy file');
    expect(copyFile).toHaveBeenLastCalledWith(path);
    await rightClick(image);
    await selectMenuItem(container, 'Preview image');
    const menuPreview = preview.mock.calls[0];
    await click(image);
    expect(preview.mock.calls[1]).toEqual(menuPreview);
    expect(menuPreview?.[5]).toEqual([path]);
  });

  it.each(['https://images.example.test/sample.png', 'blob:sample-preview'])('keeps URL-only image %s content-copyable without file actions', async (url) => {
    await render(createElement(ImageThumbnail, { resource: { kind: 'preview-url', url }, alt: 'Sample picture', onPreview: vi.fn() }));
    await rightClick(container.querySelector('img')!);
    expect(menuLabels(container)).toEqual(['Preview image', 'Copy image']);
    vi.mocked(copyImage).mockRejectedValueOnce(new Error('Sample image could not be decoded'));
    await selectMenuItem(container, 'Copy image');
    expect(copyImage).toHaveBeenLastCalledWith({ kind: 'url', url });
    expect(toast()).toMatchObject({ tone: 'error', title: 'Action failed: Sample image could not be decoded' });
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('closes a replaced image source before accepting another action', async () => {
    const view = (url: string) => createElement(ImageThumbnail, { resource: { kind: 'preview-url', url }, alt: 'Sample picture' });
    await render(view('https://images.example.test/first.png'));
    await rightClick(container.querySelector('img')!);
    expect(menuLabels(container)).toEqual(['Copy image']);
    await render(view('https://images.example.test/second.png'));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await rightClick(container.querySelector('img')!);
    await selectMenuItem(container, 'Copy image');
    expect(copyImage).toHaveBeenCalledExactlyOnceWith({ kind: 'url', url: 'https://images.example.test/second.png' });
  });

  it('copies the original draft Blob, preserves the existing X, and never removes via the menu', async () => {
    const remove = vi.fn();
    const preview = vi.fn();
    await render(createElement(GateAttachments, { images: [draftImage], files: [{ id: 'sample-file', name: 'sample.txt', path: '/workspace/sample.txt' }],
      onRemove: remove, onPreviewImage: preview }));
    await rightClick(container.querySelector('img')!);
    expect(menuLabels(container)).toEqual(['Preview image', 'Copy image']);
    await selectMenuItem(container, 'Copy image');
    expect(copyImage).toHaveBeenCalledExactlyOnceWith({ kind: 'blob', blob: draftImage.blob, name: draftImage.name });
    expect(preview).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await rightClick(container.querySelector('[title="/workspace/sample.txt"]')!);
    await selectMenuItem(container, 'Copy file');
    expect(copyFile).toHaveBeenCalledExactlyOnceWith('/workspace/sample.txt');
    await click(container.querySelector('[title="/workspace/sample.txt"] button')!);
    expect(remove).toHaveBeenCalledExactlyOnceWith('sample-file');
    await click(container.querySelector('img')!);
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0]?.[0]).toMatch(/^blob:/);
    preview.mock.calls[0]?.[3]?.();
  });

  it.each(['pending_approval', 'approved'] as const)('uses the actual %s output path without changing image selection on right-click', async (status) => {
    const preview = vi.fn();
    const path = status === 'approved' ? '/workspace/result.png' : '/workspace/candidate.png';
    await render(createElement(ImageReview, { target: { agentId: 'sample-agent' }, onPreviewImage: preview, node: {
      id: 'sample-node', createdAt: 1, status, target: { providerId: 'sample-provider', modelId: 'sample-model' },
      images: [{ id: 'sample-output', status: 'completed', version: 1, prompt: 'Sample illustration',
        candidatePath: '/workspace/candidate.png', outputPath: '/workspace/result.png' }],
    } }));
    const image = container.querySelector('img')!;
    await rightClick(image);
    expect(container.querySelector('[data-selected="true"]')).toBeNull();
    expect(preview).not.toHaveBeenCalled();
    await selectMenuItem(container, 'Copy path');
    expect(copyText).toHaveBeenCalledExactlyOnceWith(path);
    await rightClick(image);
    await selectMenuItem(container, 'Preview image');
    expect(preview.mock.calls[0]?.[5]).toEqual([path]);
    expect(container.querySelector('[data-selected="true"]')).toBeNull();
  });

  it('uses each lightbox image source, including right-clicking a nonactive thumbnail', async () => {
    const urls = ['piskie-attachment://preview/local', 'https://images.example.test/remote.png'];
    await render(createElement(ImageLightbox, { preview: { urls, index: 0, sourcePaths: ['/workspace/local.png', undefined] }, onClose: vi.fn() }));
    await rightClick(container.querySelector('img')!);
    await selectMenuItem(container, 'Copy path');
    expect(copyText).toHaveBeenLastCalledWith('/workspace/local.png');
    const thumbnails = [...container.querySelectorAll<HTMLButtonElement>('[class*="rail"] > button')];
    await rightClick(thumbnails[1]!);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(urls[0]);
    expect(menuLabels(container)).toEqual(['Preview image', 'Copy image']);
    await selectMenuItem(container, 'Copy image');
    expect(copyImage).toHaveBeenLastCalledWith({ kind: 'url', url: urls[1], name: undefined });
    await click(thumbnails[1]!);
    await rightClick(container.querySelector('img')!);
    expect(menuLabels(container)).toEqual(['Copy image']);
    await selectMenuItem(container, 'Copy image');
    expect(copyImage).toHaveBeenLastCalledWith({ kind: 'url', url: urls[1], name: undefined });
    await click(thumbnails[0]!);
    await click(container.querySelector('[data-copy-status]')!);
    expect(copyImage).toHaveBeenLastCalledWith({ kind: 'path', path: '/workspace/local.png' });
  });

  it('gives Markdown images their own menu and retains relative-path preview metadata', async () => {
    const preview = vi.fn();
    await render(createElement(MarkdownImageContext.Provider, { value: { baseDirectory: '/workspace/docs', onPreviewImage: preview } },
      createElement(MarkdownImage, { src: '../assets/sample.png', alt: 'Sample image',
        domNode: new HtmlElement('img', {}, []), streamStatus: 'done' }),
    ));
    const image = container.querySelector('img')!;
    await act(async () => image.dispatchEvent(new dom.window.Event('load')));
    await rightClick(image);
    expect(preview).not.toHaveBeenCalled();
    await selectMenuItem(container, 'Copy file');
    expect(copyFile).toHaveBeenCalledExactlyOnceWith('/workspace/assets/sample.png');
    await rightClick(image);
    await selectMenuItem(container, 'Preview image');
    expect(preview.mock.calls[0]?.[5]).toEqual(['/workspace/assets/sample.png']);
  });
});
