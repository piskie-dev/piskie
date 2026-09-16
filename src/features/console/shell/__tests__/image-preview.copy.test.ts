import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopyImageRequest } from '@shared/electron-contracts/desktop';
import { AttachmentThumbnail } from '../../attachments/AttachmentThumbnail';
import type { ReadyAttachmentImage } from '../../attachments/model';
import { deferred, gifBytes, pngBytes } from '../../attachments/__tests__/fixtures';
import { clearAllComposerDrafts, useComposerDraftStore } from '../../data/composer-drafts';
import ImageLightbox from '../../content/ImageLightbox';
import { useConsoleShell, type ConsoleShell } from '../useConsoleShell';

const runtime = vi.hoisted(() => ({ agentRuns: { refresh: vi.fn(async () => undefined) } }));
const thumbnail = vi.hoisted(() => vi.fn<() => Promise<Blob>>());
vi.mock('@/renderer-runtime/hooks', () => ({
  useRendererRuntime: () => runtime,
  useAgentControl: (select: (state: { agentsById: Record<string, never> }) => unknown) => select({ agentsById: {} }),
  useAgentRunPreview: (select: (state: { state: null }) => unknown) => select({ state: null }),
}));
vi.mock('@/features/console/data/session', () => ({ useHistoryRows: () => [], useSessionRows: () => [] }));
vi.mock('@/features/console/data/actions', () => ({ useConsoleActions: () => ({ loadHistory: vi.fn() }) }));
vi.mock('../../attachments/thumbnail', () => ({ createImageThumbnail: thumbnail }));

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let shell: ConsoleShell;
const publish = vi.fn<(request: CopyImageRequest) => Promise<void>>();
const firstBytes = gifBytes(2, 2, [
  { left: 0, top: 0, width: 2, height: 2 },
  { left: 0, top: 0, width: 2, height: 2 },
]);
const secondBytes = gifBytes(3, 2);
const first: ReadyAttachmentImage = { id: 'first', status: 'ready', name: 'looping-shapes.gif', blob: new Blob([firstBytes], { type: 'image/gif' }) };
const second: ReadyAttachmentImage = { id: 'second', status: 'ready', name: 'small-shapes.gif', blob: new Blob([secondBytes], { type: 'image/gif' }) };

function PreviewHarness() {
  const current = useConsoleShell();
  const drafts = useComposerDraftStore((state) => state.drafts);
  useLayoutEffect(() => { shell = current; });
  return createElement('div', null,
    createElement('div', { 'data-attachment-previews': true },
      (drafts.sample?.attachments.images ?? []).map((image) => createElement(AttachmentThumbnail, {
        key: image.id, image, alt: 'Sample attachment', onPreview: current.setPreviewImage,
      }))),
    createElement(ImageLightbox, { preview: current.previewImage, onClose: () => current.setPreviewImage(null) }));
}

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.assign(window, { piskie: { desktop: { files: { copyImage: publish } } } });
});
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  clearAllComposerDrafts();
  publish.mockReset().mockResolvedValue(undefined);
  thumbnail.mockReset().mockResolvedValue(new Blob([pngBytes()], { type: 'image/png' }));
  useComposerDraftStore.setState({ drafts: { sample: {
    text: '', edit: {}, skills: [], attachments: { images: [first, second], files: [] },
  } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(PreviewHarness)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearAllComposerDrafts();
  container.remove();
  vi.restoreAllMocks();
});
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

const copyButton = () => container.querySelector<HTMLButtonElement>('dialog [data-copy-status]')!;
const picture = () => container.querySelector<HTMLImageElement>('dialog img')!;
const click = (element: HTMLElement) => act(async () => element.click());
const galleryButton = (key: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t(key)}"]`)!;
const openAttachment = (name: string) => click(container.querySelector<HTMLImageElement>(`[data-attachment-previews] img[title="${name}"]`)!);
async function copyOriginal() {
  const expectedCalls = publish.mock.calls.length + 1;
  await act(async () => {
    copyButton().click();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(expectedCalls));
  });
}

describe('attachment preview copy integration', () => {
  it('keeps original names and GIF bytes through the thumbnail, shell and lightbox while releasing replaced URLs', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const pending = deferred<void>();
    publish.mockReturnValueOnce(pending.promise);
    await openAttachment(first.name);
    const originalUrl = picture().src;
    expect(originalUrl).not.toBe(container.querySelector<HTMLImageElement>(`[data-attachment-previews] img[title="${first.name}"]`)!.src);
    await copyOriginal();
    expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'bytes', bytes: firstBytes.buffer, name: first.name });
    await act(async () => useComposerDraftStore.getState().removeAttachment('sample', first.id));
    expect(revoke).not.toHaveBeenCalledWith(originalUrl);
    await click(galleryButton('sessionWorkbenchUi.lightbox.close'));
    expect(revoke.mock.calls.filter(([url]) => url === originalUrl)).toHaveLength(1);
    await openAttachment(second.name);
    expect(copyButton().disabled).toBe(true);
    await act(async () => pending.resolve());
    expect(copyButton().textContent).toBe('Copy image');
    await copyOriginal();
    expect(publish).toHaveBeenLastCalledWith({ kind: 'bytes', bytes: secondBytes.buffer, name: second.name });
    const secondUrl = picture().src;
    await click(galleryButton('sessionWorkbenchUi.lightbox.close'));
    expect(revoke.mock.calls.filter(([url]) => url === secondUrl)).toHaveLength(1);
  });

  it('associates a supplied name only with the opening gallery item and preserves the fourth release argument', async () => {
    const firstUrl = `data:image/gif;base64,${Buffer.from(firstBytes).toString('base64')}`;
    const secondUrl = `data:image/gif;base64,${Buffer.from(secondBytes).toString('base64')}`;
    const release = vi.fn();
    await act(async () => shell.setPreviewImage(secondUrl, [firstUrl, secondUrl], 1, release, second.name));
    await copyOriginal();
    expect(publish).toHaveBeenLastCalledWith({ kind: 'bytes', bytes: secondBytes.buffer, name: second.name });
    await click(galleryButton('sessionWorkbenchUi.lightbox.previous'));
    expect(picture().src).toBe(firstUrl);
    await copyOriginal();
    expect(publish).toHaveBeenLastCalledWith({ kind: 'bytes', bytes: firstBytes.buffer, name: undefined });
    await click(galleryButton('sessionWorkbenchUi.lightbox.next'));
    await copyOriginal();
    expect(publish).toHaveBeenLastCalledWith({ kind: 'bytes', bytes: secondBytes.buffer, name: second.name });
    expect(release).not.toHaveBeenCalled();
    await click(galleryButton('sessionWorkbenchUi.lightbox.close'));
    expect(release).toHaveBeenCalledOnce();
  });
});
