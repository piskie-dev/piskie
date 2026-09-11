import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllComposerDrafts, useComposerDraftStore, WELCOME_DRAFT_KEY } from '../../data/composer-drafts';
import { useAttachmentDraft, type AttachmentDraft } from '../useAttachmentDraft';
import { pngBytes, deferred } from './fixtures';

const clipboardAttachments = vi.fn();
const releasePreview = vi.fn();
const onText = vi.fn();
let root: Root;
let dom: JSDOM;
const draftRef = React.createRef<AttachmentDraft>();
const Probe = React.forwardRef<AttachmentDraft, { readonly draftKey?: string }>(function Probe({ draftKey }, ref) {
  const draft = useAttachmentDraft(draftKey, onText);
  React.useImperativeHandle(ref, () => draft, [draft]);
  return null;
});
const draft = () => draftRef.current!;
const render = async (draftKey?: string) => { await act(async () => root.render(React.createElement(Probe, { ref: draftRef, draftKey }))); };
function paste(files: readonly File[] = [], plain = '', uris = '') {
  const input = document.createElement('textarea');
  input.value = 'Before after'; input.setSelectionRange(7, 7);
  return { clipboardData: { items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
    getData: (type: string) => type === 'text/plain' ? plain : type === 'text/uri-list' ? uris : '', types: [],
  }, currentTarget: input, preventDefault: vi.fn() } as unknown as React.ClipboardEvent;
}
async function settle() {
  const captures = new Set(draft().images.flatMap((image) => image.status === 'capturing' ? [image.capture] : []));
  await act(async () => { await Promise.all([...captures].map((capture) => capture.done.catch(() => undefined))); });
}
const imageFile = () => new File([pngBytes()], 'sample.png', { type: 'image/png' });

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'File', 'FileReader', 'Blob'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  clipboardAttachments.mockReset().mockResolvedValue([]);
  releasePreview.mockReset().mockResolvedValue(undefined);
  onText.mockReset();
  Object.defineProperty(window, 'piskie', { value: { desktop: {
    system: { clipboardAttachments }, files: { releasePreview },
  } } });
  clearAllComposerDrafts();
  root = createRoot(document.createElement('div'));
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearAllComposerDrafts();
  dom.window.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('paste event capture', () => {
  it('leaves ordinary paragraphs, including embedded paths, to default text insertion', () => {
    const event = paste([], 'Example paragraph\n/workspace/sample.png');
    act(() => draft().handlePaste(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(clipboardAttachments).not.toHaveBeenCalled();
  });

  it('starts real reads in the callback and sends independently captured original bytes', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    const file = imageFile();
    const event = paste([file]);
    act(() => draft().handlePaste(event));
    expect(read).toHaveBeenCalledOnce();
    expect(draft().images[0]?.status).toBe('capturing');
    const send = vi.fn().mockResolvedValue(undefined);
    await act(async () => { expect(await draft().withImages(send)).toBe(true); });
    const ready = draft().images[0]!;
    expect(ready.status).toBe('ready');
    if (ready.status === 'ready') expect(ready.blob).not.toBe(file);
    expect(send).toHaveBeenCalledWith([{ data: Buffer.from(pngBytes()).toString('base64'), media_type: 'image/png' }], []);
  });

  it('inserts mixed ordinary text once and does not rediscover a direct image', async () => {
    const event = paste([imageFile()], 'Example text', 'file:///workspace/sample.png');
    act(() => draft().handlePaste(event));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledExactlyOnceWith('Before Example textafter');
    expect(clipboardAttachments).not.toHaveBeenCalled();
    await settle();
    expect(draft().images).toHaveLength(1);
  });

  it.each(['md', 'txt'])('imports an unresolved .%s alongside a direct image using the complete native identity', async (extension) => {
    const image = imageFile();
    const text = new File(['Example'], `sample.${extension}`, { type: 'text/plain' });
    const known = new File(['Known'], 'known.md', { type: 'text/markdown' });
    Object.defineProperty(known, 'path', { value: '/workspace/known.md' });
    const other = new File(['Binary'], 'sample.bin', { type: 'application/octet-stream' });
    const files = [image, text, known, other];
    const discovery = deferred<unknown[]>();
    clipboardAttachments.mockReturnValue(discovery.promise);
    const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    act(() => draft().handlePaste(paste(files)));
    expect(read).toHaveBeenCalledExactlyOnceWith(image);
    expect(clipboardAttachments).toHaveBeenCalledExactlyOnceWith({ kind: 'native',
      files: files.map((file) => ({ name: file.name, size: file.size })), text: '' });
    discovery.resolve([
      { kind: 'image', name: image.name, path: '/workspace/sample.png', size: image.size, previewUrl: 'piskie-attachment://preview/duplicate' },
      { kind: 'file', name: text.name, path: `/workspace/${text.name}`, size: text.size },
      { kind: 'file', name: known.name, path: '/workspace/known.md', size: known.size },
      { kind: 'file', name: other.name, path: '/workspace/sample.bin', size: other.size },
    ]);
    await settle();
    expect(draft().images.map((image) => image.status)).toEqual(['ready']);
    expect(draft().files.map((file) => file.path)).toEqual(['/workspace/known.md', `/workspace/${text.name}`]);
    expect(fetch).not.toHaveBeenCalled();
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith('piskie-attachment://preview/duplicate');
    const send = vi.fn().mockResolvedValue(true);
    await act(async () => { expect(await draft().withImages(send)).toBe(true); });
    expect(send.mock.calls[0]![0]).toHaveLength(1);
    expect(send.mock.calls[0]![1]).toHaveLength(2);
  });

  it('keeps ordinary text when the image batch is rejected', () => {
    const oversized = imageFile();
    Object.defineProperty(oversized, 'size', { value: 33 * 1024 * 1024 });
    act(() => draft().handlePaste(paste([oversized], 'Example text')));
    expect(onText).toHaveBeenCalledOnce();
    expect(draft().images[0]?.status).toBe('error');
  });

  it('passes explicit event paths, captures once, and releases the source token', async () => {
    clipboardAttachments.mockResolvedValue([{ kind: 'image', name: 'sample.png', path: '/workspace/sample.png', size: pngBytes().length,
      previewUrl: 'piskie-attachment://preview/example' }]);
    const fetch = vi.fn().mockResolvedValue(new Response(pngBytes()));
    vi.stubGlobal('fetch', fetch);
    act(() => draft().handlePaste(paste([], '/workspace/sample.png')));
    expect(clipboardAttachments).toHaveBeenCalledWith({ kind: 'paths', paths: ['/workspace/sample.png'] });
    expect(onText).not.toHaveBeenCalled();
    await settle();
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith('piskie-attachment://preview/example');
    fetch.mockRejectedValue(new Error('source removed'));
    const send = vi.fn().mockResolvedValue(undefined);
    await act(async () => { expect(await draft().withImages(send)).toBe(true); });
    expect(fetch).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0][0].data).toBe(Buffer.from(pngBytes()).toString('base64'));
  });

  it('preserves text alongside URI attachments', async () => {
    clipboardAttachments.mockResolvedValue([{ kind: 'file', name: 'sample.md', path: '/workspace/sample.md', size: 10 }]);
    act(() => draft().handlePaste(paste([], 'Example text', 'file:///workspace/sample.md')));
    await settle();
    expect(onText).toHaveBeenCalledExactlyOnceWith('Before Example textafter');
    expect(draft().files[0]?.path).toBe('/workspace/sample.md');
  });

  it('shows failed path import without sending its path as text, then recovers by re-paste', async () => {
    clipboardAttachments.mockRejectedValue(new Error('source unavailable'));
    act(() => draft().handlePaste(paste([], '/workspace/sample.png')));
    await settle();
    expect(draft().images[0]?.status).toBe('error');
    expect(onText).not.toHaveBeenCalled();
    const send = vi.fn();
    await act(async () => { expect(await draft().withImages(send)).toBe(false); });
    expect(send).not.toHaveBeenCalled();
    act(() => draft().handlePaste(paste([imageFile()])));
    await settle();
    expect(draft().images.map((image) => image.status)).toEqual(['ready']);
  });

  it('retains filesystem text files as path references', () => {
    const file = new File(['Example'], 'sample.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'path', { value: '/workspace/sample.md' });
    act(() => draft().handlePaste(paste([file])));
    expect(draft().files).toEqual([expect.objectContaining({ path: '/workspace/sample.md' })]);
    expect(clipboardAttachments).not.toHaveBeenCalled();
  });

  it('keeps keyed attachments across switching and unmount', async () => {
    await render('agent:example-one');
    act(() => draft().handlePaste(paste([imageFile()])));
    await settle();
    await render('agent:example-two');
    expect(draft().images).toHaveLength(0);
    await act(async () => root.render(null));
    await render('agent:example-one');
    expect(draft().images[0]?.status).toBe('ready');
    act(() => draft().clear());
    expect(draft().images).toHaveLength(0);
  });

  it.each(['clear', 'reset'])('does not repopulate after %s while discovering', async (action) => {
    await render(WELCOME_DRAFT_KEY);
    const discovery = deferred<unknown[]>();
    clipboardAttachments.mockReturnValue(discovery.promise);
    act(() => draft().handlePaste(paste([], '', 'file:///workspace/sample.md')));
    const capture = draft().images[0]!;
    act(() => action === 'clear' ? draft().clear() : useComposerDraftStore.getState().resetDraft(WELCOME_DRAFT_KEY));
    await act(async () => {
      discovery.resolve([{ kind: 'file', name: 'sample.md', path: '/workspace/sample.md', size: 1 }]);
      if (capture.status === 'capturing') await capture.capture.done.catch(() => undefined);
    });
    expect(draft().images).toHaveLength(0);
    expect(draft().files).toHaveLength(0);
  });
});
