import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilePreviewDescriptor } from '../../../../../shared/electron-contracts/desktop';
import { deferred } from '../../attachments/__tests__/fixtures';
import { useImagePreviewUrl } from '@/hooks/useImagePreviewUrl';

const preview = vi.fn();
const releasePreview = vi.fn();
const committed: Array<string | null> = [];
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const image = (name: string): FilePreviewDescriptor => ({
  kind: 'image', url: `piskie-attachment://preview/${name}`, mediaType: 'image/png', size: 4,
});
function Probe({ sourcePath, version = 0 }: { sourcePath?: string; version?: number }) {
  const { url } = useImagePreviewUrl(sourcePath, version);
  useLayoutEffect(() => { committed.push(url); });
  return createElement('output', null, url);
}
async function render(sourcePath?: string, version = 0) {
  committed.length = 0;
  await act(async () => root.render(createElement(Probe, { sourcePath, version })));
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  preview.mockReset();
  releasePreview.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'piskie', { value: { desktop: { files: { preview, releasePreview } } } });
  container = document.createElement('div');
  root = createRoot(container);
  committed.length = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('disk image preview ownership', () => {
  it.each([
    { name: 'path', sourcePath: '/workspace/second.png', version: 0 },
    { name: 'version', sourcePath: '/workspace/first.png', version: 1 },
  ])('clears a changed $name before commit and never reuses a released URL on return', async ({ sourcePath, version }) => {
    const next = deferred<FilePreviewDescriptor>();
    const returned = deferred<FilePreviewDescriptor>();
    preview.mockResolvedValueOnce(image('first')).mockReturnValueOnce(next.promise).mockReturnValueOnce(returned.promise);
    await render('/workspace/first.png');
    expect(container.textContent).toBe('piskie-attachment://preview/first');

    await render(sourcePath, version);
    expect(committed).toEqual([null]);
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith('piskie-attachment://preview/first');
    await render('/workspace/first.png');
    expect(committed).toEqual([null]);
    await act(async () => next.resolve(image('stale')));
    expect(container.textContent).toBe('');
    expect(releasePreview).toHaveBeenLastCalledWith('piskie-attachment://preview/stale');
    await act(async () => returned.resolve(image('returned')));
    expect(container.textContent).toBe('piskie-attachment://preview/returned');

    await act(async () => root.render(null));
    expect(releasePreview.mock.calls).toEqual([
      ['piskie-attachment://preview/first'], ['piskie-attachment://preview/stale'], ['piskie-attachment://preview/returned'],
    ]);
  });

  it('releases a disabled source and acquires a fresh preview when it returns', async () => {
    preview.mockResolvedValueOnce(image('first'));
    await render('/workspace/first.png');
    await render();
    expect(committed).toEqual([null]);
    expect(preview).toHaveBeenCalledOnce();
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith('piskie-attachment://preview/first');
    const pending = deferred<FilePreviewDescriptor>();
    preview.mockReturnValueOnce(pending.promise);
    await render('/workspace/first.png');
    expect(committed).toEqual([null]);
    await act(async () => pending.resolve(image('returned')));
    expect(container.textContent).toBe('piskie-attachment://preview/returned');
  });

  it.each(['failure', 'non-image'])('keeps a replacement empty after a %s', async (outcome) => {
    preview.mockResolvedValueOnce(image('first'));
    await render('/workspace/first.png');
    if (outcome === 'failure') preview.mockRejectedValueOnce(new Error('Example preview failure'));
    else preview.mockResolvedValueOnce({ kind: 'file', mediaType: 'application/pdf', size: 4 });
    await render('/workspace/second.png');
    expect(committed.every((url) => url === null)).toBe(true);
    expect(container.textContent).toBe('');
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith('piskie-attachment://preview/first');
  });

  it('ignores a rejected old request after a newer preview is displayed', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    preview.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(image('current'));
    await render('/workspace/first.png');
    await render('/workspace/second.png');
    await act(async () => pending.reject(new Error('Example stale failure')));
    expect(container.textContent).toBe('piskie-attachment://preview/current');
    expect(releasePreview).not.toHaveBeenCalled();
  });

  it('releases both StrictMode requests, including a response arriving after unmount', async () => {
    const stale = deferred<FilePreviewDescriptor>();
    const current = deferred<FilePreviewDescriptor>();
    preview.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    await act(async () => root.render(createElement(StrictMode, null,
      createElement(Probe, { sourcePath: '/workspace/example.png' }))));
    expect(preview).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(image('current')));
    expect(container.textContent).toBe('piskie-attachment://preview/current');
    await act(async () => root.render(null));
    await act(async () => stale.resolve(image('stale')));
    expect(releasePreview.mock.calls).toEqual([
      ['piskie-attachment://preview/current'], ['piskie-attachment://preview/stale'],
    ]);
  });
});
