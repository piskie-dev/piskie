import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import React, { act, cloneElement, createElement, useLayoutEffect, useRef, useState, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilePreviewDescriptor } from '@shared/electron-contracts/desktop';
import { PiskieFault } from '@shared/electron-contracts/public-fault';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import type { ImagePreviewHandler } from '@/components/image-preview/renderedImageContext';
import { deferred } from '../../attachments/__tests__/fixtures';
import { call, edit, result, user } from '../../data/__tests__/fileChanges.fixtures';
import { Dialog, type DialogProps } from '../../chrome/Dialog';
import overlayStyles from '../../chrome/overlay.module.css';
import collectionStyles from '../FileChangesReview.module.css';
import { ReviewSlot } from '../ReviewSlot';
import type { FileReviewTarget, PathReviewTarget, ReviewableFilePreview } from '../fileReviewTarget';

vi.mock('@/components/content-links', () => ({ LinkedMarkdown: ({ children }: { children: string }) => {
  markdown(children);
  return createElement('article', null, children);
} }));
vi.mock('../../chrome/Tooltip', () => ({ Tooltip: ({ children, title }: { children: ReactElement; title: string }) => cloneElement(children, { title } as object) }));
vi.mock('../../data/useTranscript', () => ({ useTranscript: () => ({ nodes }) }));
vi.mock('../../data/useFileChanges', () => ({ useFileChanges: () => ({ rounds: [], loading: false, error: null }) }));

const markdown = vi.fn();
const previewFile = vi.fn<(path: string) => Promise<FilePreviewDescriptor>>();
const revision = vi.fn<(path: string) => Promise<string | null>>();
const releasePreview = vi.fn(async (_url: string) => undefined);
const copy = vi.fn(async (_text: string) => undefined);
const revealPath = vi.fn();
const update = vi.fn();
interface Watch {
  path: string;
  listener: (revision: string | null) => void;
  error?: (error: unknown) => void;
  stop: ReturnType<typeof vi.fn>;
}
let watches: Watch[];
let diskRevision: string | null;
let visibility: DocumentVisibilityState;
let nodes: TranscriptNode[];
const observe = vi.fn((path: string, listener: Watch['listener'], error?: Watch['error']) => {
  const stop = vi.fn();
  watches.push({ path, listener, error, stop });
  listener(diskRevision);
  return stop;
});
const text = (content = '# Sample snapshot', revision = 'revision-one'): ReviewableFilePreview => ({
  kind: 'text', content, revision, truncated: false, size: content.length,
});
const target = (path = '/workspace/sample.md', preview = text()): PathReviewTarget => ({ kind: 'path', path, preview });
const image = (): FilePreviewDescriptor => ({ kind: 'image', revision: 'revision-two', url: 'piskie-attachment://preview/sample', mediaType: 'image/png', size: 4 });
const fault = (code: 'not-found' | 'forbidden' = 'forbidden') => new PiskieFault({
  code, message: 'Sample public reason', correlationId: 'sample-correlation', retryable: true,
});
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let setTarget: Dispatch<SetStateAction<FileReviewTarget | undefined>>;
function Owner({ initial, onPreviewImage, inDialog = false, agentId = 'sample-session' }: {
  initial?: FileReviewTarget;
  onPreviewImage?: ImagePreviewHandler;
  inDialog?: boolean;
  agentId?: string;
}) {
  const [current, setCurrent] = useState<FileReviewTarget | undefined>(initial);
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { setTarget = setCurrent; }, [setCurrent]);
  const review = React.createElement(ReviewSlot, { agentId, target: current, onPreviewImage,
    scrollContainerRef: inDialog ? bodyRef : undefined,
    onUpdateTarget: (expected, next) => {
      update(expected, next);
      setCurrent((existing) => existing === expected ? next ?? undefined : existing);
    },
  });
  return inDialog ? React.createElement(Dialog, {
    open: current !== undefined, onClose: () => setCurrent(undefined), title: 'Review', width: 880,
    bodyRef, className: collectionStyles.dialog,
  } as DialogProps, current ? review : null) : review;
}

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  Object.assign(window, { piskie: { desktop: { files: { preview: previewFile, revision, observe, releasePreview },
    system: { openPath: vi.fn(), revealPath } } } });
});
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  visibility = 'visible';
  diskRevision = 'revision-one';
  watches = [];
  nodes = [];
  vi.clearAllMocks();
  previewFile.mockReset().mockImplementation(async () => text('# Updated snapshot', 'revision-two'));
  revision.mockReset().mockImplementation(async () => diskRevision);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
async function render(initial: FileReviewTarget = target(), onPreviewImage?: ImagePreviewHandler) {
  await act(async () => root.render(createElement(Owner, { initial, onPreviewImage })));
}
const refreshButton = () => container.querySelector<HTMLButtonElement>('button[data-state]')!;
const indicator = () => {
  expect(container.querySelector('[role="status"]')).toBeNull();
  return refreshButton()?.dataset.state;
};
const scroll = () => container.querySelector<HTMLDivElement>('[class*="scroll"]')!;
const dialogBody = () => container.querySelector<HTMLDivElement>(`.${overlayStyles.dialogBody}`)!;
async function renderDialog(initial?: FileReviewTarget) {
  await act(async () => root.render(createElement(Owner, { initial, inDialog: true })));
}
const watch = () => watches.at(-1)!;
async function change(next: string | null) {
  diskRevision = next;
  await act(async () => watch().listener(next));
}
async function refresh() { await act(async () => refreshButton().click()); }
async function focus() { await act(async () => window.dispatchEvent(new dom.window.Event('focus'))); }
async function show(next: DocumentVisibilityState) {
  visibility = next;
  await act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange')));
}

describe('live local path review', () => {
  it('does not report success for initial, repeated, or replacement snapshots without a manual refresh', async () => {
    vi.useFakeTimers();
    await render(target('/workspace/generic.md'));
    expect(indicator()).toBe('current');
    await change('revision-one');
    await focus();
    await act(async () => setTarget(target('/workspace/generic.md', text('# Generic replacement'))));
    expect(indicator()).toBe('current');
    expect(refreshButton().querySelector('.lucide-check')).toBeNull();
    expect(refreshButton().title).toBe('刷新');
    expect(vi.getTimerCount()).toBe(0);
    expect(previewFile).not.toHaveBeenCalled();
  });

  it('shows manual refresh success for 1200ms even for unchanged content without extending it on repeated snapshots', async () => {
    vi.useFakeTimers();
    previewFile.mockResolvedValue(text());
    await render();
    await refresh();
    expect(indicator()).toBe('success');
    expect(refreshButton().querySelector('.lucide-check')).not.toBeNull();
    expect(refreshButton().querySelector('[class*="refreshMarker"]')).toBeNull();
    expect(refreshButton().getAttribute('aria-label')).toBe('更新成功: 刷新');
    expect(container.querySelector('[class*="header"]')?.textContent).toBe('sample.md预览');
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTime(600));
    await change('revision-one');
    await act(async () => vi.advanceTimersByTime(599));
    expect(indicator()).toBe('success');
    await act(async () => vi.advanceTimersByTime(1));
    expect(indicator()).toBe('current');
    expect(refreshButton().querySelector('.lucide-refresh-cw')).not.toBeNull();
    expect(refreshButton().title).toBe('刷新');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts brief success feedback for another manual refresh of the same revision', async () => {
    vi.useFakeTimers();
    previewFile.mockResolvedValue(text());
    await render();
    await refresh();
    await act(async () => vi.advanceTimersByTime(1000));
    await refresh();
    expect(previewFile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTime(1199));
    expect(indicator()).toBe('success');
    await act(async () => vi.advanceTimersByTime(1));
    expect(indicator()).toBe('current');
  });

  it('waits for the completed manual refresh and its metadata check before reporting success', async () => {
    const pending = deferred<string | null>();
    revision.mockReturnValueOnce(pending.promise);
    previewFile.mockResolvedValueOnce(text());
    await render();
    await refresh();
    expect(refreshButton().disabled).toBe(true);
    expect(indicator()).toBe('current');
    expect(refreshButton().title).toBe('刷新');
    expect(update).not.toHaveBeenCalled();
    await act(async () => pending.resolve('revision-one'));
    expect(indicator()).toBe('success');
    expect(update).toHaveBeenCalledOnce();
  });

  it('replaces success immediately with a pending-update marker and clears its timer on a new change', async () => {
    vi.useFakeTimers();
    diskRevision = 'revision-two';
    await render();
    await refresh();
    expect(indicator()).toBe('success');
    await change('revision-three');
    expect(indicator()).toBe('changed');
    expect(refreshButton().querySelector('.lucide-check')).toBeNull();
    expect(refreshButton().querySelector('[class*="refreshMarker"]')).not.toBeNull();
    expect(refreshButton().title).toBe('刷新');
    expect(vi.getTimerCount()).toBe(0);
    await change('revision-two');
    expect(indicator()).toBe('current');
    await act(async () => vi.advanceTimersByTime(1500));
    expect(indicator()).toBe('current');
  });

  it.each(['focus', 'watch'] as const)('replaces success with a compact persistent failure from %s without changing the body', async (source) => {
    vi.useFakeTimers();
    diskRevision = 'revision-two';
    await render();
    await refresh();
    const body = container.querySelector('article');
    if (source === 'focus') { revision.mockRejectedValueOnce(fault()); await focus(); }
    else await act(async () => watch().error?.(fault()));
    expect(indicator()).toBe('error');
    expect(refreshButton().querySelector('.lucide-triangle-alert')).not.toBeNull();
    expect(refreshButton().title).toBe('更新失败\nSample public reason\n刷新');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(indicator()).toBe('error');
    expect(container.querySelector('article')).toBe(body);
    expect(container.querySelector('[class*="header"]')?.textContent).toBe('sample.md预览');
  });

  it.each(['path', 'scope', 'dismiss'] as const)('clears the success timer and feedback after %s changes', async (kind) => {
    vi.useFakeTimers();
    diskRevision = 'revision-two';
    await render();
    await refresh();
    expect(indicator()).toBe('success');
    expect(vi.getTimerCount()).toBe(1);
    if (kind === 'path') await act(async () => setTarget(target('/workspace/generic.md', text('# Generic document', 'revision-two'))));
    else if (kind === 'scope') await act(async () => root.render(createElement(Owner, { agentId: 'generic-session' })));
    else await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    if (kind !== 'dismiss') expect(indicator()).toBe('current');
    await act(async () => vi.advanceTimersByTime(1500));
    if (kind !== 'dismiss') expect(indicator()).toBe('current');
  });

  it('compares the first snapshot, never rereads automatically, and avoids Markdown renders on repeated notifications', async () => {
    diskRevision = 'revision-two';
    await render();
    expect(indicator()).toBe('changed');
    expect(refreshButton().getAttribute('data-changed')).toBe('true');
    expect(refreshButton().title).toBe('刷新');
    expect(refreshButton().querySelector('[class*="refreshMarker"]')).not.toBeNull();
    expect(markdown).toHaveBeenCalledOnce();
    const body = container.querySelector('article');
    await change('revision-two');
    await change('revision-three');
    expect(markdown).toHaveBeenCalledOnce();
    expect(container.querySelector('article')).toBe(body);
    expect(body?.textContent).toBe('# Sample snapshot');
    expect(previewFile).not.toHaveBeenCalled();
    expect(revision).not.toHaveBeenCalled();
  });

  it('quietly disables refresh while keeping the old body and actions, then reports success to the owner', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    previewFile.mockReturnValueOnce(pending.promise);
    const original = target();
    await render(original);
    await change('revision-two');
    const oldScroll = scroll();
    await refresh();
    expect(refreshButton().disabled).toBe(true);
    expect(refreshButton().getAttribute('aria-busy')).toBe('true');
    expect(indicator()).toBe('changed');
    expect(refreshButton().title).toBe('刷新');
    expect(refreshButton().querySelector('.lucide-refresh-cw')).not.toBeNull();
    expect(container.querySelector('[class*="header"]')?.textContent).toBe('sample.md预览');
    await refresh();
    expect(previewFile).toHaveBeenCalledOnce();
    expect(container.querySelector('article')?.textContent).toBe('# Sample snapshot');
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="复制内容"]')!.click());
    expect(copy).toHaveBeenLastCalledWith('# Sample snapshot');
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="在文件夹中显示"]')!.click());
    expect(revealPath).toHaveBeenCalledWith(original.path);
    const updated = text('# Latest snapshot', 'revision-two');
    await act(async () => pending.resolve(updated));
    expect(update).toHaveBeenCalledExactlyOnceWith(original, { ...original, preview: updated });
    expect(container.querySelector('article')?.textContent).toBe('# Latest snapshot');
    expect(indicator()).toBe('success');
    expect(refreshButton().querySelector('.lucide-check')).not.toBeNull();
    expect(refreshButton().title).toBe('更新成功\n刷新');
    expect(refreshButton().disabled).toBe(false);
    expect(scroll()).toBe(oldScroll);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="复制内容"]')!.click());
    expect(copy).toHaveBeenLastCalledWith('# Latest snapshot');
  });

  it('permits an explicit refresh even when the snapshot is current', async () => {
    await render();
    diskRevision = 'revision-two';
    await refresh();
    expect(previewFile).toHaveBeenCalledExactlyOnceWith('/workspace/sample.md');
    expect(indicator()).toBe('success');
    expect(container.querySelector('article')?.textContent).toBe('# Updated snapshot');
  });

  it('preserves the snapshot on a public error, exposes the reason, and retries using the same button', async () => {
    previewFile.mockRejectedValueOnce(fault());
    await render();
    await refresh();
    expect(indicator()).toBe('error');
    expect(refreshButton().querySelector('.lucide-triangle-alert')).not.toBeNull();
    expect(refreshButton().title).toContain('Sample public reason');
    expect(refreshButton().getAttribute('aria-label')).toBe('更新失败: 刷新');
    expect(container.querySelector('article')?.textContent).toBe('# Sample snapshot');
    expect(update).not.toHaveBeenCalled();
    diskRevision = 'revision-two';
    await refresh();
    expect(indicator()).toBe('success');
    expect(update).toHaveBeenCalledOnce();
  });

  it('keeps one failure result and changes only its tooltip reason when the path disappears', async () => {
    previewFile.mockRejectedValueOnce(fault());
    await render();
    await refresh();
    expect(indicator()).toBe('error');
    await change(null);
    expect(indicator()).toBe('error');
    expect(refreshButton().title).toBe('更新失败\n文件不存在或已移动\n刷新');
    expect(refreshButton().title).not.toContain('Sample public reason');
  });

  it('keeps the body when the refreshed path is not found', async () => {
    previewFile.mockRejectedValueOnce(fault('not-found'));
    await render();
    await refresh();
    expect(indicator()).toBe('error');
    expect(refreshButton().getAttribute('aria-label')).toBe('更新失败: 刷新');
    expect(container.querySelector('article')?.textContent).toBe('# Sample snapshot');
    expect(refreshButton().disabled).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('reports a missing revision and recovers when the file is recreated', async () => {
    diskRevision = null;
    await render();
    expect(indicator()).toBe('error');
    diskRevision = 'revision-two';
    await refresh();
    expect(indicator()).toBe('success');
  });

  it.each(['missing', 'error'] as const)('retains the old body if metadata becomes %s after a successful read', async (outcome) => {
    await render();
    if (outcome === 'missing') revision.mockResolvedValueOnce(null);
    else revision.mockRejectedValueOnce(fault());
    await refresh();
    expect(indicator()).toBe('error');
    expect(refreshButton().title).toContain('更新失败');
    expect(refreshButton().title).toContain(outcome === 'missing' ? '文件不存在或已移动' : 'Sample public reason');
    expect(update).not.toHaveBeenCalled();
    expect(container.querySelector('article')?.textContent).toBe('# Sample snapshot');
  });

  it('keeps an unread change received during refresh, including an event newer than the metadata response', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    const metadata = deferred<string | null>();
    previewFile.mockReturnValueOnce(pending.promise);
    revision.mockReturnValueOnce(metadata.promise);
    await render();
    await change('revision-two');
    await refresh();
    await act(async () => pending.resolve(text('# Read revision two', 'revision-two')));
    await change('revision-three');
    await act(async () => metadata.resolve('revision-two'));
    expect(indicator()).toBe('changed');
    expect(refreshButton().querySelector('.lucide-check')).toBeNull();
    expect(container.querySelector('article')?.textContent).toBe('# Read revision two');
    previewFile.mockResolvedValueOnce(text('# Read revision three', 'revision-three'));
    await refresh();
    expect(indicator()).toBe('success');
  });

  it('clears the notification when a change during refresh is included in the returned preview', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    previewFile.mockReturnValueOnce(pending.promise);
    await render();
    await refresh();
    await change('revision-two');
    await act(async () => pending.resolve(text('# Included change', 'revision-two')));
    expect(indicator()).toBe('success');
  });

  it('rechecks metadata on focus without reading the body and discards out-of-order responses', async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    revision.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    await focus();
    await focus();
    await act(async () => second.resolve('revision-two'));
    await act(async () => first.resolve('revision-one'));
    expect(indicator()).toBe('changed');
    expect(previewFile).not.toHaveBeenCalled();
    expect(markdown).toHaveBeenCalledOnce();
  });

  it('pauses while hidden, resubscribes on visibility restoration, and ignores a retired listener', async () => {
    await render();
    const old = watch();
    await show('hidden');
    expect(old.stop).toHaveBeenCalledOnce();
    diskRevision = 'revision-two';
    await focus();
    expect(revision).not.toHaveBeenCalled();
    await show('visible');
    expect(observe).toHaveBeenCalledTimes(2);
    expect(revision).toHaveBeenCalledExactlyOnceWith('/workspace/sample.md');
    expect(indicator()).toBe('changed');
    await act(async () => old.listener('revision-one'));
    expect(indicator()).toBe('changed');
    expect(previewFile).not.toHaveBeenCalled();
  });

  it('does not subscribe while initially hidden and catches changes when shown', async () => {
    visibility = 'hidden';
    await render();
    expect(observe).not.toHaveBeenCalled();
    diskRevision = 'revision-two';
    await show('visible');
    expect(indicator()).toBe('changed');
  });

  it('releases a terminated subscription and rebuilds it after a successful manual refresh', async () => {
    await render();
    const failed = watch();
    await act(async () => failed.error?.(fault()));
    expect(failed.stop).toHaveBeenCalledOnce();
    expect(indicator()).toBe('error');
    expect(refreshButton().title).toContain('Sample public reason');
    diskRevision = 'revision-two';
    await refresh();
    expect(indicator()).toBe('success');
    expect(observe).toHaveBeenCalledTimes(2);
    await change('revision-three');
    expect(indicator()).toBe('changed');
    await act(async () => failed.listener('revision-two'));
    expect(indicator()).toBe('changed');
  });

  it('rebuilds observation after an error delivered during initial subscription setup', async () => {
    const stop = vi.fn();
    observe.mockImplementationOnce((_path, _listener, onError) => { onError?.(fault()); return stop; });
    await render();
    expect(stop).toHaveBeenCalledOnce();
    expect(indicator()).toBe('error');
    diskRevision = 'revision-two';
    await refresh();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(indicator()).toBe('success');
    await change('revision-three');
    expect(indicator()).toBe('changed');
  });

  it('retains an error from a new subscription that fails immediately after refresh', async () => {
    await render();
    await act(async () => watch().error?.(fault()));
    const stop = vi.fn();
    observe.mockImplementationOnce((_path, _listener, onError) => { onError?.(fault()); return stop; });
    diskRevision = 'revision-two';
    await refresh();
    expect(stop).toHaveBeenCalledOnce();
    expect(indicator()).toBe('error');
    expect(container.querySelector('article')?.textContent).toBe('# Updated snapshot');
    await refresh();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(indicator()).toBe('success');
  });

  it('ignores old preview, revision, and watch results after changing the target', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    const metadata = deferred<string | null>();
    previewFile.mockReturnValueOnce(pending.promise);
    revision.mockReturnValueOnce(metadata.promise);
    await render();
    const old = watch();
    await focus();
    await refresh();
    await act(async () => setTarget(target('/workspace/other.md', text('# Other snapshot'))));
    expect(old.stop).toHaveBeenCalledOnce();
    await act(async () => {
      old.listener(null);
      old.error?.(fault());
      pending.resolve(text('# Obsolete content', 'revision-two'));
      metadata.resolve(null);
    });
    expect(container.querySelector('article')?.textContent).toBe('# Other snapshot');
    expect(indicator()).toBe('current');
    expect(update).not.toHaveBeenCalled();
  });

  it('discards a metadata response after the same path receives a replacement snapshot', async () => {
    const pending = deferred<string | null>();
    revision.mockReturnValueOnce(pending.promise);
    await render();
    await focus();
    await act(async () => setTarget(target('/workspace/sample.md', text('# Replacement'))));
    await act(async () => pending.resolve(null));
    expect(container.querySelector('article')?.textContent).toBe('# Replacement');
    expect(indicator()).toBe('current');
  });

  it.each(['file', 'directory'] as const)('replaces a text snapshot with a refreshed %s card', async (kind) => {
    const descriptor: ReviewableFilePreview = kind === 'file'
      ? { kind, revision: 'revision-two', size: 20, mediaType: 'application/octet-stream' }
      : { kind, revision: 'revision-two' };
    previewFile.mockResolvedValueOnce(descriptor);
    diskRevision = 'revision-two';
    await render();
    const element = scroll();
    await refresh();
    expect(scroll()).toBe(element);
    expect(indicator()).toBe('success');
    expect(container.querySelector('article')).toBeNull();
    expect(container.querySelector('[class*="cardMain"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="复制内容"]')).toBeNull();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ kind: 'path' }), expect.objectContaining({ preview: descriptor }));
  });

  it('discards an old same-path response when a new snapshot replaces the target', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    previewFile.mockReturnValueOnce(pending.promise);
    await render();
    await refresh();
    await act(async () => setTarget(target('/workspace/sample.md', text('# Replacement', 'revision-three'))));
    await act(async () => pending.resolve(text('# Obsolete', 'revision-two')));
    expect(container.querySelector('article')?.textContent).toBe('# Replacement');
    expect(refreshButton().disabled).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('releases an image returned after unmount and does not update the owner', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    previewFile.mockReturnValueOnce(pending.promise);
    await render();
    await refresh();
    await act(async () => root.render(null));
    await act(async () => pending.resolve(image()));
    expect(watch().stop).toHaveBeenCalledOnce();
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith('piskie-attachment://preview/sample');
    expect(update).not.toHaveBeenCalled();
  });

  it('does not let an old request affect a reopened panel for the same path', async () => {
    const pending = deferred<FilePreviewDescriptor>();
    previewFile.mockReturnValueOnce(pending.promise);
    await render();
    await refresh();
    await act(async () => root.render(null));
    await render(target('/workspace/sample.md', text('# Reopened')));
    await act(async () => pending.resolve(text('# Obsolete', 'revision-two')));
    expect(container.querySelector('article')?.textContent).toBe('# Reopened');
    expect(update).not.toHaveBeenCalled();
  });

  it.each([900, 240] as const)('retains the scroll node and clamps the position for a content height of %i', async (height) => {
    await render();
    const element = scroll();
    Object.defineProperties(element, { scrollHeight: { configurable: true, get: () => height }, clientHeight: { value: 200 } });
    element.scrollTop = 350;
    diskRevision = 'revision-two';
    await refresh();
    expect(scroll()).toBe(element);
    expect(element.scrollTop).toBe(Math.min(350, height - 200));
    await act(async () => setTarget(target('/workspace/other.md')));
    expect(scroll()).not.toBe(element);
    expect(scroll().scrollTop).toBe(0);
  });

  it.each([1200, 760] as const)('restores the actual Dialog body on same-path refresh with content height %i', async (height) => {
    await renderDialog(target());
    const body = dialogBody();
    const inner = scroll();
    Object.defineProperties(body, { scrollHeight: { get: () => height }, clientHeight: { value: 620 } });
    body.scrollTop = 450;
    inner.scrollTop = 17;
    const pending = deferred<FilePreviewDescriptor>();
    previewFile.mockReturnValueOnce(pending.promise);
    await refresh();
    body.scrollTop = 420;
    diskRevision = 'revision-two';
    await act(async () => pending.resolve(text('# Refreshed snapshot', 'revision-two')));
    expect(dialogBody()).toBe(body);
    expect(scroll()).toBe(inner);
    expect(body.scrollTop).toBe(Math.min(420, height - 620));
    expect(inner.scrollTop).toBe(17);
  });

  it('resets the persistent Dialog body when switching paths', async () => {
    await renderDialog(target());
    const body = dialogBody();
    const inner = scroll();
    body.scrollTop = 450;
    await act(async () => setTarget(target('/workspace/other.md')));
    expect(dialogBody()).toBe(body);
    expect(scroll()).not.toBe(inner);
    expect(body.scrollTop).toBe(0);
  });

  it('starts initial and reopened paths at the top of the persistent Dialog body', async () => {
    await renderDialog();
    const body = dialogBody();
    body.scrollTop = 450;
    await act(async () => setTarget(target()));
    expect(body.scrollTop).toBe(0);
    body.scrollTop = 450;
    await act(async () => container.querySelector<HTMLDialogElement>('dialog')!.close());
    expect(refreshButton()).toBeNull();
    body.scrollTop = 300;
    await act(async () => setTarget(target('/workspace/other.md')));
    expect(dialogBody()).toBe(body);
    expect(body.scrollTop).toBe(0);
  });

  it.each(['lightbox', 'no-handler', 'throwing-handler'] as const)('routes a new image type through %s with correct URL ownership', async (mode) => {
    const open = mode === 'no-handler' ? undefined : vi.fn<ImagePreviewHandler>();
    if (mode === 'throwing-handler') open!.mockImplementation(() => { throw fault(); });
    previewFile.mockResolvedValueOnce(image());
    diskRevision = 'revision-two';
    await render(target(), open);
    await refresh();
    if (mode === 'throwing-handler') {
      expect(indicator()).toBe('error');
      expect(update).not.toHaveBeenCalled();
      expect(container.querySelector('article')?.textContent).toBe('# Sample snapshot');
    } else {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ kind: 'path' }), null);
      expect(refreshButton()).toBeNull();
    }
    if (mode === 'lightbox') {
      expect(releasePreview).not.toHaveBeenCalled();
      await act(async () => open!.mock.calls[0]![3]!());
    }
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith('piskie-attachment://preview/sample');
  });

  it('keeps recorded reads, changes, and collections as snapshots with no local subscriptions', async () => {
    nodes = projectConversationNodes([user('sample-turn'), ...edit('sample-edit', 'Old recorded', 'New recorded'),
      call('sample-read', 'read', { file_path: '/workspace/sample.md' }), result('sample-read', '1\tRecorded body')]);
    await render({ kind: 'cell', cellId: 'sample-read' });
    expect(container.textContent).toContain('Recorded body');
    await act(async () => setTarget({ kind: 'cell', cellId: 'sample-edit' }));
    expect(container.textContent).toContain('New recorded');
    await act(async () => setTarget({ kind: 'collection' }));
    expect(refreshButton()).toBeNull();
    expect(observe).not.toHaveBeenCalled();
    expect(previewFile).not.toHaveBeenCalled();
    await focus();
    expect(revision).not.toHaveBeenCalled();
  });
});
