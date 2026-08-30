import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllComposerDrafts } from '../../data/composer-drafts';
import { useAttachmentDraft, type AttachmentDraft } from '../useAttachmentDraft';

const clipboardAttachments = vi.fn();
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

let container: HTMLDivElement;
let root: Root;
let dom: JSDOM;
const draftRef = React.createRef<AttachmentDraft>();

const Probe = React.forwardRef<AttachmentDraft, { readonly draftKey?: string }>(function Probe(
  { draftKey },
  ref,
): null {
  const draft = useAttachmentDraft(draftKey);
  React.useImperativeHandle(ref, () => draft, [draft]);
  return null;
});

function currentDraft(): AttachmentDraft {
  if (!draftRef.current) throw new Error('Attachment draft is not mounted');
  return draftRef.current;
}

async function renderProbe(draftKey?: string): Promise<void> {
  await act(async () => root.render(React.createElement(Probe, { ref: draftRef, draftKey })));
}

async function hideProbe(): Promise<void> {
  await act(async () => root.render(null));
}

function pasteEvent(
  items: readonly Partial<DataTransferItem>[],
  uriList = '',
): React.ClipboardEvent {
  return {
    clipboardData: {
      items,
      getData: (type: string) => (type === 'text/uri-list' ? uriList : ''),
    },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent;
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const expose = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose('window', dom.window);
  expose('document', dom.window.document);
  expose('navigator', dom.window.navigator);
  expose('File', dom.window.File);
  expose('FileReader', dom.window.FileReader);
  expose('Blob', dom.window.Blob);
  expose('URL', dom.window.URL);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  clipboardAttachments.mockReset().mockResolvedValue([]);
  createObjectURL.mockReset().mockImplementation(() => `blob:preview-${createObjectURL.mock.calls.length}`);
  revokeObjectURL.mockReset();
  Object.defineProperty(window, 'piskie', {
    configurable: true,
    value: { desktop: { system: { clipboardAttachments } } },
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  clearAllComposerDrafts();
  container = document.createElement('div');
  root = createRoot(container);
  await renderProbe();
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearAllComposerDrafts();
  dom.window.close();
});

describe('useAttachmentDraft', () => {
  it('does not intercept ordinary text paste', () => {
    const event = pasteEvent([{ kind: 'string' }]);

    act(() => currentDraft().handlePaste(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(clipboardAttachments).not.toHaveBeenCalled();
    expect(currentDraft().hasAttachments).toBe(false);
  });

  it('uses an object URL for an immediate thumbnail and encodes only for submission', async () => {
    const image = new File(['image-bytes'], 'capture.png', { type: 'image/png' });
    const event = pasteEvent([{ kind: 'file', getAsFile: () => image }]);

    act(() => currentDraft().handlePaste(event));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(currentDraft().images).toHaveLength(1);
    expect(currentDraft().images[0]?.previewUrl).toBe('blob:preview-1');
    expect(clipboardAttachments).not.toHaveBeenCalled();
    await expect(currentDraft().imagePayloads()).resolves.toEqual([{
      data: 'aW1hZ2UtYnl0ZXM=',
      media_type: 'image/png',
    }]);

    const id = currentDraft().images[0]!.id;
    act(() => currentDraft().remove(id));
    expect(currentDraft().images).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it('retains filesystem text attachments as path references', () => {
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'path', { value: '/tmp/notes.md' });
    const event = pasteEvent([{ kind: 'file', getAsFile: () => file }]);

    act(() => currentDraft().handlePaste(event));

    expect(currentDraft().files).toEqual([expect.objectContaining({
      name: 'notes.md',
      path: '/tmp/notes.md',
    })]);
    expect(clipboardAttachments).not.toHaveBeenCalled();
  });

  it('keeps keyed attachments isolated and restores them after unmount', async () => {
    await renderProbe('agent:a');
    const image = new File(['image-a'], 'a.png', { type: 'image/png' });
    act(() => currentDraft().handlePaste(pasteEvent([{ kind: 'file', getAsFile: () => image }])));

    expect(currentDraft().images).toHaveLength(1);
    await renderProbe('agent:b');
    expect(currentDraft().images).toHaveLength(0);

    await hideProbe();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await renderProbe('agent:a');
    expect(currentDraft().images).toHaveLength(1);
    act(() => currentDraft().clear());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it('delivers delayed clipboard results to the target that initiated them', async () => {
    let resolveDescriptors!: (value: Array<{ name: string; path: string; size: number }>) => void;
    clipboardAttachments.mockReturnValue(new Promise((resolve) => {
      resolveDescriptors = resolve;
    }));
    await renderProbe('agent:a');

    act(() => currentDraft().handlePaste(pasteEvent([], 'file:///tmp/notes.md')));
    await renderProbe('agent:b');
    await act(async () => {
      resolveDescriptors([{ name: 'notes.md', path: '/tmp/notes.md', size: 5 }]);
      await Promise.resolve();
    });

    expect(currentDraft().files).toHaveLength(0);
    await renderProbe('agent:a');
    expect(currentDraft().files).toEqual([expect.objectContaining({ path: '/tmp/notes.md' })]);
  });

  it('ignores a delayed clipboard result after the draft is cleared', async () => {
    let resolveDescriptors!: (value: Array<{ name: string; path: string; size: number }>) => void;
    clipboardAttachments.mockReturnValue(new Promise((resolve) => {
      resolveDescriptors = resolve;
    }));
    const event = pasteEvent([], 'file:///tmp/notes.md');

    act(() => currentDraft().handlePaste(event));
    expect(clipboardAttachments).toHaveBeenCalledOnce();
    act(() => currentDraft().clear());
    await act(async () => {
      resolveDescriptors([{ name: 'notes.md', path: '/tmp/notes.md', size: 5 }]);
      await Promise.resolve();
    });

    expect(currentDraft().files).toHaveLength(0);
    expect(currentDraft().images).toHaveLength(0);
  });
});
