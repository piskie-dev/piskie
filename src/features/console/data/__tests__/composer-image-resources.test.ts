import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadyAttachmentImage, ImagePayload } from '../../attachments/model';
import { deferred } from '../../attachments/__tests__/fixtures';

const ports = vi.hoisted(() => ({ file: vi.fn(), source: vi.fn(), encode: vi.fn(), thumbnail: vi.fn(), release: vi.fn() }));
vi.mock('../../attachments/capture', () => ({ captureFile: ports.file, captureSource: ports.source }));
vi.mock('../../attachments/submission', () => ({ blobToImagePayload: ports.encode }));
vi.mock('../../attachments/thumbnail', () => ({ createImageThumbnail: ports.thumbnail }));
vi.mock('../../attachments/image-format', async (original) => {
  const actual = await original<typeof import('../../attachments/image-format')>();
  return { ...actual, IMAGE_LIMITS: { ...actual.IMAGE_LIMITS, imageBytes: 8, draftBytes: 12, totalBytes: 24, captureBytes: 12, thumbnailBytes: 4 } };
});
import {
  captureComposerImages, clearAllComposerDrafts, clearAgentComposerDrafts, composerImageUsage,
  getComposerAttachments, observeAttachmentThumbnail, submitComposerDraft, useComposerDraftStore, withAttachmentSubmission,
} from '../composer-drafts';
const file = (size = 4) => new File([new Uint8Array(size)], 'example.png', { type: 'image/png' });
const blob = (size = 4) => new Blob([new Uint8Array(size)], { type: 'image/png' });
const state = () => useComposerDraftStore.getState();
const ready = (key: string) => getComposerAttachments(key).images[0] as ReadyAttachmentImage;
async function importFile(key: string, size = 4) {
  captureComposerImages(key, [file(size)]);
  const image = getComposerAttachments(key).images.at(-1)!;
  if (image.status === 'capturing') await image.capture.done;
  return ready(key);
}
function batch(key: string) {
  const image = getComposerAttachments(key).images.find((item) => item.status === 'capturing');
  if (image?.status !== 'capturing') throw new Error('Expected an active capture');
  return image.capture;
}
const ticks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => {
  clearAllComposerDrafts();
  ports.file.mockReset().mockImplementation(async (source: File) => new Blob([await source.arrayBuffer()], { type: source.type }));
  ports.source.mockReset().mockResolvedValue(blob(3));
  ports.encode.mockReset().mockResolvedValue({ data: 'sample-encoding', media_type: 'image/png' });
  ports.thumbnail.mockReset().mockResolvedValue(blob(3));
  ports.release.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('window', { piskie: { desktop: { files: { releasePreview: ports.release } } } });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:example-${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(async () => {
  clearAllComposerDrafts();
  await ticks();
  expect(composerImageUsage()).toEqual({ originalBytes: 0, captureBytes: 0, thumbnailBytes: 0 });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('capture budget and batch ownership', () => {
  it('reserves known bytes atomically and starts all direct reads without queuing', async () => {
    const pending = [deferred<Blob>(), deferred<Blob>()];
    ports.file.mockImplementationOnce(() => pending[0]!.promise).mockImplementationOnce(() => pending[1]!.promise);
    captureComposerImages('one', [file(4), file(4)]);
    const capture = batch('one');
    expect(ports.file).toHaveBeenCalledTimes(2);
    expect(composerImageUsage()).toMatchObject({ originalBytes: 8, captureBytes: 8 });
    captureComposerImages('two', [file(6)]);
    expect(ports.file).toHaveBeenCalledTimes(2);
    expect(getComposerAttachments('two').images[0]?.status).toBe('error');
    pending[0]!.resolve(blob(4)); await ticks();
    expect(getComposerAttachments('one').images.every((image) => image.status === 'capturing')).toBe(true);
    pending[1]!.resolve(blob(4)); await capture.done;
    expect(composerImageUsage()).toMatchObject({ originalBytes: 8, captureBytes: 0 });
  });

  it('enforces per-image, per-draft and renderer-wide budgets without dropping existing drafts', async () => {
    captureComposerImages('large', [file(9)]);
    expect(ports.file).not.toHaveBeenCalled();
    await importFile('one', 8); await importFile('one', 4);
    captureComposerImages('one', [file(1)]);
    expect(getComposerAttachments('one').images.filter((image) => image.status === 'ready')).toHaveLength(2);
    await importFile('two', 8); await importFile('two', 4);
    expect(composerImageUsage().originalBytes).toBe(24);
    captureComposerImages('three', [file(1)]);
    expect(getComposerAttachments('three').images[0]?.status).toBe('error');
    expect(composerImageUsage().originalBytes).toBe(24);
  });

  it('reserves unknown B before discovery and shrinks only after all sources release', async () => {
    await importFile('one', 4);
    const discover = deferred<never[]>();
    const release = deferred<void>();
    ports.release.mockReturnValue(release.promise);
    const descriptors = [{ kind: 'image' as const, name: 'source.png', path: '/workspace/source.png', size: 1, previewUrl: 'piskie-attachment://preview/example' }];
    captureComposerImages('one', [file(1)], () => discover.promise);
    const capture = batch('one');
    expect(composerImageUsage()).toMatchObject({ originalBytes: 12, captureBytes: 8 });
    expect(ports.file).toHaveBeenCalledTimes(2);
    discover.resolve(descriptors as never[]); await ticks();
    expect(ports.source).toHaveBeenCalledWith(descriptors[0]!.previewUrl, 7, expect.any(AbortSignal));
    expect(composerImageUsage()).toMatchObject({ originalBytes: 12, captureBytes: 8 });
    release.resolve(); await capture.done;
    expect(composerImageUsage()).toMatchObject({ originalBytes: 8, captureBytes: 0 });
  });

  it('keeps the batch reservation until every source release settles even when one release fails', async () => {
    const delayed = deferred<void>();
    ports.release.mockRejectedValueOnce(new Error('release failed')).mockReturnValueOnce(delayed.promise);
    captureComposerImages('one', [], async () => [
      { kind: 'image', name: 'first.png', path: '/workspace/first.png', size: 1, previewUrl: 'piskie-attachment://preview/first' },
      { kind: 'image', name: 'second.png', path: '/workspace/second.png', size: 1, previewUrl: 'piskie-attachment://preview/second' },
    ]);
    const capture = batch('one'); await ticks();
    expect(ports.release).toHaveBeenCalledTimes(2);
    expect(composerImageUsage().captureBytes).toBe(12);
    delayed.resolve(); await expect(capture.done).rejects.toThrow('release failed');
    expect(composerImageUsage().captureBytes).toBe(0);
    expect(getComposerAttachments('one').images[0]?.status).toBe('error');
  });

  it('rolls back the whole batch and holds reservations until uncancellable readers settle', async () => {
    const slow = deferred<Blob>();
    ports.file.mockImplementationOnce(() => slow.promise).mockRejectedValueOnce(new Error('source failed'));
    captureComposerImages('one', [file(4), file(4)]);
    const capture = batch('one');
    await ticks();
    expect(capture.controller.signal.aborted).toBe(true);
    expect(composerImageUsage().captureBytes).toBe(8);
    slow.resolve(blob(4));
    await expect(capture.done).rejects.toThrow('source failed');
    expect(getComposerAttachments('one').images.map((image) => image.status)).toEqual(['error']);
    expect(composerImageUsage().originalBytes).toBe(0);
  });

  it.each(['remove', 'clear', 'reset', 'delete'])('settles a cancelled batch after %s without repopulating', async (action) => {
    const slow = deferred<Blob>(); ports.file.mockReturnValue(slow.promise);
    captureComposerImages('agent:example', [file()]); const capture = batch('agent:example');
    if (action === 'remove') state().removeAttachment('agent:example', getComposerAttachments('agent:example').images[0]!.id);
    if (action === 'clear') state().clearAttachments('agent:example');
    if (action === 'reset') state().resetDraft('agent:example');
    if (action === 'delete') clearAgentComposerDrafts('example');
    expect(composerImageUsage().originalBytes).toBe(4);
    slow.resolve(blob()); await expect(capture.done).rejects.toThrow('cancelled');
    expect(getComposerAttachments('agent:example').images).toHaveLength(0);
    expect(composerImageUsage().originalBytes).toBe(0);
  });
});

describe('submission snapshots and temporary encoding', () => {
  it('clears on success when capture preparation is the only change', async () => {
    const slow = deferred<Blob>(); ports.file.mockReturnValue(slow.promise);
    state().setDraft('one', 'Example body');
    captureComposerImages('one', [file()]);
    const send = vi.fn().mockResolvedValue(true);
    const submitted = submitComposerDraft('one', send);
    expect(send).not.toHaveBeenCalled();
    slow.resolve(blob()); await submitted;
    expect(send.mock.calls[0]![0].text).toBe('Example body');
    expect(state().drafts.one).toBeUndefined();
  });

  it('fixes body, skills and batches at click time while preserving later edits', async () => {
    const slow = deferred<Blob>(); ports.file.mockReturnValueOnce(slow.promise);
    state().setDraft('one', 'First body'); state().setSkills('one', ['example-skill']);
    captureComposerImages('one', [file()]);
    const send = vi.fn().mockResolvedValue(true);
    const submitted = submitComposerDraft('one', send);
    state().setDraft('one', 'Next body'); state().setSkills('one', ['next-skill']);
    await importFile('one', 2);
    slow.resolve(blob()); await submitted;
    expect(send.mock.calls[0]![0]).toMatchObject({ text: 'First body', skills: ['example-skill'] });
    expect(send.mock.calls[0]![1]).toHaveLength(1);
    expect(state().drafts.one).toMatchObject({ text: 'Next body', skills: ['next-skill'] });
    expect(getComposerAttachments('one').images).toHaveLength(2);
  });

  it('accounts for an out-of-order capture immediately and cancels removal before an earlier batch settles', async () => {
    await importFile('other', 8); await importFile('other', 4);
    const earlier = deferred<Blob>(); const later = deferred<Blob>();
    ports.file.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
    captureComposerImages('one', [file()]); const firstBatch = batch('one');
    captureComposerImages('one', [file()]);
    const last = getComposerAttachments('one').images.at(-1)!;
    if (last.status !== 'capturing') throw new Error('Expected capture');
    const send = vi.fn().mockResolvedValue(true);
    const operation = submitComposerDraft('one', send);
    const outcome = operation.catch((error: unknown) => error);
    later.resolve(blob()); await expect(last.capture.done).resolves.toBeUndefined();
    expect(composerImageUsage().originalBytes).toBe(20);
    state().removeAttachment('one', last.id);
    expect(composerImageUsage().originalBytes).toBe(20);
    // No completed Blob is kept in capture.done, so cancellation can settle independently.
    await ticks();
    expect(await outcome).toMatchObject({ message: expect.stringContaining('cancelled') });
    expect(composerImageUsage()).toMatchObject({ originalBytes: 16, captureBytes: 4 });
    await importFile('next', 8);
    expect(composerImageUsage().originalBytes).toBe(24);
    earlier.resolve(blob()); await firstBatch.done;
    expect(send).not.toHaveBeenCalled(); expect(ports.encode).not.toHaveBeenCalled();
  });

  it('preserves selected image order when capture batches finish in reverse order', async () => {
    const earlier = deferred<Blob>(); const later = deferred<Blob>();
    ports.file.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
    captureComposerImages('one', [file(3)]);
    captureComposerImages('one', [file(4)]);
    ports.encode.mockImplementation(async (image: Blob) => ({ data: String(image.size), media_type: image.type }));
    const send = vi.fn().mockResolvedValue(true);
    const operation = submitComposerDraft('one', send);
    later.resolve(blob(4)); await ticks(); earlier.resolve(blob(3));
    await expect(operation).resolves.toBe(true);
    expect(send.mock.calls[0]![1].map((image: ImagePayload) => image.data)).toEqual(['3', '4']);
  });

  it('does not keep a cancelled selection or adopt late results after resetting a draft', async () => {
    await importFile('one', 3);
    const pending = deferred<Blob>(); ports.file.mockReturnValueOnce(pending.promise);
    captureComposerImages('one', [file(4)]); const capture = batch('one');
    const send = vi.fn(); const operation = submitComposerDraft('one', send);
    const outcome = operation.catch((error: unknown) => error);
    state().resetDraft('one'); await ticks();
    expect(await outcome).toMatchObject({ message: expect.stringContaining('cancelled') });
    expect(composerImageUsage()).toMatchObject({ originalBytes: 4, captureBytes: 4 });
    pending.resolve(blob(4)); await expect(capture.done).rejects.toThrow('cancelled');
    expect(composerImageUsage().originalBytes).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['text', 'image'])('delivers a text-only draft while another %s delivery is pending', async (kind) => {
    if (kind === 'image') await importFile('one');
    state().setDraft('one', 'First body'); state().setDraft('two', 'Second body');
    const delivered = deferred<boolean>();
    const first = submitComposerDraft('one', () => delivered.promise); await ticks();
    const send = vi.fn().mockResolvedValue(true);
    await expect(submitComposerDraft('two', send)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Second body' }), undefined, []);
    expect(ports.encode).toHaveBeenCalledTimes(kind === 'image' ? 1 : 0);
    await expect(submitComposerDraft('one', vi.fn())).rejects.toThrow('preparing');
    delivered.resolve(true); await first;
  });

  it('delivers a text-file discovery without waiting for the image channel', async () => {
    await importFile('one');
    const delivered = deferred<void>(); const first = withAttachmentSubmission('one', () => delivered.promise);
    await ticks();
    captureComposerImages('two', [], async () => [{ kind: 'file', name: 'example.md', path: '/workspace/example.md', size: 1 }]);
    const send = vi.fn().mockResolvedValue(true);
    await expect(withAttachmentSubmission('two', send)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(undefined, [expect.objectContaining({ path: '/workspace/example.md' })]);
    delivered.resolve(); await first;
  });

  it('re-encodes the stable Blob after encoding failure and IPC failure', async () => {
    const original = await importFile('one');
    ports.encode.mockRejectedValueOnce(new Error('encoding failed'));
    await expect(submitComposerDraft('one', vi.fn())).rejects.toThrow('encoding failed');
    expect(await submitComposerDraft('one', async () => false)).toBe(false);
    expect(ready('one')).toBe(original);
    expect(await submitComposerDraft('one', async () => true)).toBe(true);
    expect(ports.file).toHaveBeenCalledOnce();
    expect(ports.encode).toHaveBeenCalledTimes(3);
    expect(ports.encode.mock.calls.every(([value]) => value === original.blob)).toBe(true);
  });

  it('serializes preparation through IPC settlement across different drafts', async () => {
    await importFile('one'); await importFile('two');
    const delivered = deferred<boolean>();
    const first = submitComposerDraft('one', () => delivered.promise);
    const second = submitComposerDraft('two', async () => true);
    await ticks(); expect(ports.encode).toHaveBeenCalledTimes(1);
    delivered.resolve(true); await Promise.all([first, second]);
    expect(ports.encode).toHaveBeenCalledTimes(2);
  });

  it('cancels selected ready-image removal during encoding but holds bytes until the encoder ends', async () => {
    const image = await importFile('one');
    const encoded = deferred<ImagePayload>(); ports.encode.mockReturnValue(encoded.promise);
    const send = vi.fn().mockResolvedValue(true);
    const operation = submitComposerDraft('one', send); await ticks();
    state().removeAttachment('one', image.id);
    expect(composerImageUsage().originalBytes).toBe(4);
    expect(ports.encode.mock.calls[0]![2].aborted).toBe(true);
    encoded.resolve({ data: 'example', media_type: 'image/png' });
    await expect(operation).rejects.toThrow('cancelled');
    expect(send).not.toHaveBeenCalled();
    expect(composerImageUsage().originalBytes).toBe(0);
  });

  it('does not cancel removal of a later image and does not clear the edited draft', async () => {
    await importFile('one');
    const encoded = deferred<ImagePayload>(); ports.encode.mockReturnValue(encoded.promise);
    const send = vi.fn().mockResolvedValue(true);
    const operation = submitComposerDraft('one', send); await ticks();
    await importFile('one', 2);
    state().removeAttachment('one', getComposerAttachments('one').images[1]!.id);
    encoded.resolve({ data: 'example', media_type: 'image/png' });
    await expect(operation).resolves.toBe(true);
    expect(getComposerAttachments('one').images).toHaveLength(1);
  });

  it('cancels a queued send before it can encode a removed selection', async () => {
    await importFile('one'); const image = await importFile('two');
    const delivered = deferred<void>();
    const first = withAttachmentSubmission('one', () => delivered.promise);
    const send = vi.fn(); const second = withAttachmentSubmission('two', send);
    await ticks(); state().removeAttachment('two', image.id);
    expect(composerImageUsage().originalBytes).toBe(8);
    delivered.resolve(); await first;
    await expect(second).rejects.toThrow('cancelled');
    expect(send).not.toHaveBeenCalled(); expect(ports.encode).toHaveBeenCalledOnce();
    expect(composerImageUsage().originalBytes).toBe(4);
  });

  it('allows edits after IPC starts without withdrawing delivery or losing new text', async () => {
    await importFile('one');
    const delivered = deferred<boolean>(); const send = vi.fn(() => delivered.promise);
    const operation = submitComposerDraft('one', send); await ticks();
    expect(send).toHaveBeenCalledOnce();
    state().resetDraft('one'); state().setDraft('one', 'Next message');
    expect(composerImageUsage().originalBytes).toBe(4);
    delivered.resolve(true); await expect(operation).resolves.toBe(true);
    expect(state().drafts.one?.text).toBe('Next message');
    expect(composerImageUsage().originalBytes).toBe(0);
  });
});

describe('derived preview resources', () => {
  it('processes thumbnails singly, evicts inactive derived bytes, and preserves originals', async () => {
    const first = await importFile('one'); const second = await importFile('two');
    const render = deferred<Blob>(); ports.thumbnail.mockReturnValueOnce(render.promise);
    const stop = observeAttachmentThumbnail(first, vi.fn());
    const notice = vi.fn(); observeAttachmentThumbnail(second, notice);
    await ticks(); expect(ports.thumbnail).toHaveBeenCalledTimes(1);
    stop(); render.resolve(blob(3)); await ticks();
    expect(ports.thumbnail).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(composerImageUsage()).toMatchObject({ originalBytes: 8, thumbnailBytes: 3 });
    expect(notice).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  it('keeps active thumbnail failures sendable and releases a removed image only after processing ends', async () => {
    const image = await importFile('one');
    const rendering = deferred<Blob>(); ports.thumbnail.mockReturnValueOnce(rendering.promise);
    observeAttachmentThumbnail(image, vi.fn()); await ticks();
    state().removeAttachment('one', image.id);
    expect(composerImageUsage().originalBytes).toBe(4);
    rendering.reject(new Error('decoder failed')); await ticks();
    expect(composerImageUsage().originalBytes).toBe(0);
    const other = await importFile('two'); ports.thumbnail.mockRejectedValueOnce(new Error('decoder failed'));
    observeAttachmentThumbnail(other, vi.fn()); await ticks();
    await expect(submitComposerDraft('two', async () => true)).resolves.toBe(true);
  });
});
