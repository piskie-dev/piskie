import { JSDOM } from 'jsdom';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentThumbnail } from '../AttachmentThumbnail';
import type { AttachmentImage, ReadyAttachmentImage } from '../model';
import { deferred } from './fixtures';
import { captureComposerImages, clearAllComposerDrafts, getComposerAttachments, useComposerDraftStore } from '../../data/composer-drafts';

const thumbnail = vi.hoisted(() => vi.fn());
vi.mock('../thumbnail', () => ({ createImageThumbnail: thumbnail }));
vi.mock('../capture', () => ({ captureFile: async (file: File) => new Blob([await file.arrayBuffer()], { type: file.type }) }));
const committed: Array<{ url: string | null; error: string | null }> = [];
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const blob = () => new Blob([new Uint8Array(4)], { type: 'image/png' });
const displayed = () => ({
  url: container.querySelector('img')?.getAttribute('src') ?? null,
  error: container.querySelector('[role="alert"]')?.textContent ?? null,
});
function Probe({ image }: { image: AttachmentImage }) {
  useLayoutEffect(() => { committed.push(displayed()); });
  return createElement(AttachmentThumbnail, { image, alt: 'Example image' });
}
async function render(image: AttachmentImage) {
  committed.length = 0;
  await act(async () => root.render(createElement(Probe, { image })));
}
async function importImage(name: string): Promise<ReadyAttachmentImage> {
  captureComposerImages('example', [new File([new Uint8Array(4)], name, { type: 'image/png' })]);
  const pending = getComposerAttachments('example').images.at(-1)!;
  if (pending.status === 'capturing') await pending.capture.done;
  return getComposerAttachments('example').images.at(-1) as ReadyAttachmentImage;
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  thumbnail.mockReset().mockResolvedValue(blob());
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:example-${++nextUrl}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  clearAllComposerDrafts();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearAllComposerDrafts();
  dom.window.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('attachment thumbnail sources', () => {
  it.each(['ready', 'error'])('clears the previous %s result before a replacement is committed', async (kind) => {
    const first = await importImage('first.png');
    const second = await importImage('second.png');
    if (kind === 'error') thumbnail.mockRejectedValueOnce(new Error('Example thumbnail failure'));
    await render(first);
    const initial = displayed();
    expect(kind === 'ready' ? initial.url : initial.error).not.toBeNull();
    const pending = deferred<Blob>();
    thumbnail.mockReturnValueOnce(pending.promise);
    await render(second);
    expect(committed[0]).toEqual({ url: null, error: null });
    expect(displayed()).toEqual({ url: null, error: null });
    await render(first);
    expect(displayed()).toEqual(initial);
    expect(thumbnail).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(blob()));
    expect(displayed()).toEqual(initial);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => useComposerDraftStore.getState().removeAttachment('example', first.id));
    expect(displayed()).toEqual({ url: null, error: null });
    if (initial.url) expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(initial.url);
  });

  it('ignores a thumbnail completed after switching and retains the cache until draft removal', async () => {
    const first = await importImage('first.png');
    const second = await importImage('second.png');
    const oldRender = deferred<Blob>();
    const newRender = deferred<Blob>();
    thumbnail.mockReturnValueOnce(oldRender.promise).mockReturnValueOnce(newRender.promise);
    await render(first);
    await render(second);
    await act(async () => oldRender.resolve(blob()));
    expect(displayed()).toEqual({ url: null, error: null });
    await act(async () => newRender.resolve(blob()));
    expect(displayed().url).toBe('blob:example-2');
    await act(async () => root.render(null));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    clearAllComposerDrafts();
    expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([['blob:example-1'], ['blob:example-2']]);
  });
});
