/**
 * 输入草稿按投递目标驻留在 renderer 内存中。文字、附件与新会话选项共同保留，
 * 页面切换不改变草稿；显式新建或发送成功时整体重置。
 */

import { useCallback } from 'react';
import { create } from 'zustand';
import type { ApprovalMode } from '../../../../shared/types';

import type {
  AttachmentFile,
  AttachmentImage,
  ImagePayload,
  ImageCaptureTask,
  ReadyAttachmentImage,
} from '../attachments/model';

import type { ClipboardAttachmentDescriptor } from '../../../../shared/electron-contracts/desktop';
import { messageText, presentationFromError, PresentationError, type PresentationText } from '../../../i18n/presentationText';
import { captureFile, captureSource } from '../attachments/capture';
import { attachmentError, IMAGE_LIMITS } from '../attachments/image-format';
import { createImageThumbnail } from '../attachments/thumbnail';
import { blobToImagePayload } from '../attachments/submission';
import { isTextAttachment } from '../attachments/model';

export interface ComposerAttachmentState {
  readonly images: readonly AttachmentImage[];
  readonly files: readonly AttachmentFile[];
}

export const WELCOME_DRAFT_KEY = 'welcome';

/** 新增输入区选项在这里声明默认值，并通过 patchSettings 更新，即可共享保留/重置规则。 */
export interface ComposerDraftSettings {
  readonly model: string | undefined;
  readonly modeId: 'normal' | 'plan' | 'browser-skill';
  readonly approvalMode: ApprovalMode;
  readonly workspace: string | undefined;
  readonly environmentIds: readonly string[];
}

export const DEFAULT_COMPOSER_SETTINGS: ComposerDraftSettings = Object.freeze({
  model: undefined,
  modeId: 'normal',
  approvalMode: 'confirm',
  workspace: undefined,
  environmentIds: Object.freeze([]),
});

interface ComposerDraftValue {
  readonly text: string;
  /** Changes only for user edits, not capture or preview preparation. */
  readonly edit: object;
  readonly skills: readonly string[];
  readonly attachments: ComposerAttachmentState;
  /** 已有会话的运行设置由会话 owner 提供，只有待创建会话在草稿中保存设置。 */
  readonly settings?: ComposerDraftSettings;
}

const EMPTY_ATTACHMENTS: ComposerAttachmentState = Object.freeze({
  images: Object.freeze([]),
  files: Object.freeze([]),
});

const EMPTY_SKILLS: readonly string[] = Object.freeze([]);

function emptyDraft(): ComposerDraftValue {
  return { text: '', edit: {}, skills: EMPTY_SKILLS, attachments: EMPTY_ATTACHMENTS };
}

function hasAttachments(attachments: ComposerAttachmentState): boolean {
  return attachments.images.length > 0 || attachments.files.length > 0;
}

function disposeImages(images: readonly AttachmentImage[]): void {
  for (const image of images) {
    if (image.status === 'capturing') image.capture.controller.abort(attachmentError('cancelled'));
    if (image.status === 'ready') releaseThumbnail(image);
  }
}

export interface ComposerDraftStore {
  readonly drafts: Readonly<Record<string, ComposerDraftValue>>;
  readonly versions: Readonly<Record<string, number>>;
  /** 只记录页面审批控件的主动选择，驻留内存，软件重启后恢复 confirm。 */
  readonly defaults: ComposerDraftSettings;
  readonly selectApprovalMode: (mode: ApprovalMode) => void;
  readonly patchSettings: (key: string, patch: Partial<ComposerDraftSettings>, version: number) => void;
  readonly resetDraft: (key: string, settings?: Partial<ComposerDraftSettings>) => void;
  readonly setDraft: (key: string, text: string) => void;
  readonly setSkills: (key: string, skills: readonly string[]) => void;
  readonly appendFiles: (key: string, additions: readonly AttachmentFile[]) => void;
  readonly removeAttachment: (key: string, id: string) => void;
  readonly clearAttachments: (key: string) => void;
}

export const useComposerDraftStore = create<ComposerDraftStore>((set) => ({
  drafts: {},
  versions: {},
  defaults: DEFAULT_COMPOSER_SETTINGS,

  selectApprovalMode: (approvalMode) => set((state) => ({
    defaults: { ...state.defaults, approvalMode },
  })),

  patchSettings: (key, patch, version) => set((state) => {
    if ((state.versions[key] ?? 0) !== version) return state;
    const current = state.drafts[key] ?? emptyDraft();
    return {
      drafts: {
        ...state.drafts,
        [key]: {
          ...current,
          edit: {},
          skills: Object.hasOwn(patch, 'workspace') && patch.workspace !== (current.settings ?? state.defaults).workspace
            ? EMPTY_SKILLS : current.skills,
          settings: { ...(current.settings ?? state.defaults), ...patch },
        },
      },
    };
  }),

  resetDraft: (key, settings) => set((state) => {
    const current = state.drafts[key];
    if (current) disposeImages(current.attachments.images);
    const drafts = { ...state.drafts };
    if (settings) {
      drafts[key] = { ...emptyDraft(), settings: { ...state.defaults, ...settings } };
    } else {
      delete drafts[key];
    }
    return { drafts, versions: { ...state.versions, [key]: (state.versions[key] ?? 0) + 1 } };
  }),

  setDraft: (key, text) => set((state) => {
    const current = state.drafts[key] ?? emptyDraft();
    if (current.text === text) return state;

    const drafts = { ...state.drafts };
    if (text === '' && current.skills.length === 0 && !hasAttachments(current.attachments) && !current.settings) {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, text, edit: {} };
    }
    return { drafts };
  }),

  setSkills: (key, names) => set((state) => {
    const current = state.drafts[key] ?? emptyDraft();
    const skills = [...new Set(names)];
    const drafts = { ...state.drafts };
    if (skills.length === 0 && current.text === '' && !hasAttachments(current.attachments) && !current.settings) {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, skills, edit: {} };
    }
    return { drafts };
  }),

  appendFiles: (key, additions) => set((state) => {
    if (additions.length === 0) return state;
    const current = state.drafts[key] ?? emptyDraft();
    return {
      drafts: {
        ...state.drafts,
        [key]: {
          ...current,
          edit: {},
          attachments: {
            ...current.attachments,
            files: [...current.attachments.files, ...additions],
          },
        },
      },
    };
  }),

  removeAttachment: (key, id) => set((state) => {
    const current = state.drafts[key];
    if (!current) return state;

    const removed = current.attachments.images.find((image) => image.id === id);
    const images = current.attachments.images.filter((image) => image.id !== id
      && !(removed?.status === 'capturing' && image.status === 'capturing' && image.capture === removed.capture));
    const files = current.attachments.files.filter((file) => file.id !== id);
    if (images.length === current.attachments.images.length && files.length === current.attachments.files.length) return state;
    if (removed) disposeImages([removed]);
    const attachments = { images, files };
    const drafts = { ...state.drafts };
    if (current.text === '' && current.skills.length === 0 && !hasAttachments(attachments) && !current.settings) {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, attachments, edit: {} };
    }
    return { drafts };
  }),

  clearAttachments: (key) => set((state) => {
    const current = state.drafts[key];
    if (current) disposeImages(current.attachments.images);

    const drafts = { ...state.drafts };
    if (!current || (current.text === '' && current.skills.length === 0 && !current.settings)) {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, attachments: EMPTY_ATTACHMENTS, edit: {} };
    }
    return {
      drafts,
    };
  }),
}));

/** 目标键的受控文字草稿，形如 useState。 */
export function useComposerDraft(key: string): [string, (text: string) => void] {
  const value = useComposerDraftStore((state) => state.drafts[key]?.text ?? '');
  const setDraft = useComposerDraftStore((state) => state.setDraft);
  const version = useComposerDraftVersion(key);
  const setForKey = useCallback((text: string) => {
    if (getComposerDraftVersion(key) === version) setDraft(key, text);
  }, [key, setDraft, version]);
  return [value, setForKey];
}

export function useComposerSkills(key: string): [readonly string[], (skills: readonly string[]) => void] {
  const skills = useComposerDraftStore((state) => state.drafts[key]?.skills ?? EMPTY_SKILLS);
  const setSkills = useComposerDraftStore((state) => state.setSkills);
  const version = useComposerDraftVersion(key);
  const setForKey = useCallback((names: readonly string[]) => {
    if (getComposerDraftVersion(key) === version) setSkills(key, names);
  }, [key, setSkills, version]);
  return [skills, setForKey];
}

export function useComposerDraftSettings(key: string): [ComposerDraftSettings, (patch: Partial<ComposerDraftSettings>) => void] {
  const settings = useComposerDraftStore((state) => state.drafts[key]?.settings ?? state.defaults);
  const patchSettings = useComposerDraftStore((state) => state.patchSettings);
  const version = useComposerDraftVersion(key);
  const patchForKey = useCallback((patch: Partial<ComposerDraftSettings>) => {
    patchSettings(key, patch, version);
  }, [key, patchSettings, version]);
  return [settings, patchForKey];
}

/** 显式重置使旧草稿的异步回调失效；普通卸载/切换不影响版本。 */
export function getComposerDraftVersion(key: string): number {
  return useComposerDraftStore.getState().versions[key] ?? 0;
}

export function useComposerDraftVersion(key: string): number {
  return useComposerDraftStore((state) => state.versions[key] ?? 0);
}

export function useComposerAttachments(key: string): ComposerAttachmentState {
  return useComposerDraftStore((state) => state.drafts[key]?.attachments ?? EMPTY_ATTACHMENTS);
}

export function getComposerAttachments(key: string): ComposerAttachmentState {
  return useComposerDraftStore.getState().drafts[key]?.attachments ?? EMPTY_ATTACHMENTS;
}

export function clearAllComposerDrafts(): void {
  for (const release of imagePreviews) release();
  const state = useComposerDraftStore.getState();
  for (const draft of Object.values(state.drafts)) {
    disposeImages(draft.attachments.images);
  }
  const keys = new Set([...Object.keys(state.drafts), ...Object.keys(state.versions)]);
  useComposerDraftStore.setState({
    drafts: {},
    versions: Object.fromEntries([...keys].map((key) => [key, (state.versions[key] ?? 0) + 1])),
  });
}

export function composerDraftKey(agentId: string, workerId?: string): string {
  return workerId ? `worker:${agentId}:${workerId}` : `agent:${agentId}`;
}

export function clearAgentComposerDrafts(agentId: string): void {
  const state = useComposerDraftStore.getState();
  for (const key of Object.keys(state.drafts)) {
    if (key === composerDraftKey(agentId) || key.startsWith(`worker:${agentId}:`)) state.resetDraft(key);
  }
}

let nextAttachment = 0;
export function attachmentId(): string { return `attachment-${++nextAttachment}`; }

interface CaptureReservation extends ImageCaptureTask {
  readonly key: string;
  readonly bytes: number;
}
const captures = new Set<CaptureReservation>();
// Consumers hold the same resource as the draft; byte accounting deduplicates that identity.
const consumers = new Set<{ key: string; images: AttachmentImage[]; files?: AttachmentFile[] }>();

export function composerImageUsage(key?: string): {
  originalBytes: number; captureBytes: number; thumbnailBytes: number;
} {
  const images = new Set<ReadyAttachmentImage>();
  for (const [draftKey, draft] of Object.entries(useComposerDraftStore.getState().drafts)) {
    if (key !== undefined && key !== draftKey) continue;
    for (const image of draft.attachments.images) if (image.status === 'ready') images.add(image);
  }
  for (const consumer of consumers) {
    if (key === undefined || consumer.key === key) {
      for (const image of consumer.images) if (image.status === 'ready') images.add(image);
    }
  }
  let captureBytes = 0;
  for (const capture of captures) if (key === undefined || capture.key === key) captureBytes += capture.bytes;
  return {
    originalBytes: [...images].reduce((sum, image) => sum + image.blob.size, captureBytes),
    captureBytes,
    thumbnailBytes: [...thumbnails.values()].reduce((sum, entry) => sum + (entry.result?.kind === 'ready' ? entry.result.blob.size : 0), 0),
  };
}

function updateAttachments(key: string, attachments: ComposerAttachmentState, edited = false): void {
  useComposerDraftStore.setState((state) => {
    const current = state.drafts[key] ?? emptyDraft();
    return { drafts: { ...state.drafts, [key]: { ...current, attachments, ...(edited && { edit: {} }) } } };
  });
}

/** Reserves a whole batch, then starts every direct File read within the paste callback. */
export function captureComposerImages(
  key: string,
  files: readonly File[],
  discover?: () => Promise<ClipboardAttachmentDescriptor[]>,
): void {
  const current = getComposerAttachments(key);
  const previous = current.images.filter((image) => image.status !== 'error');
  const fail = (error: unknown) => updateAttachments(key, {
    ...getComposerAttachments(key),
    images: [...previous, { id: attachmentId(), name: files[0]?.name ?? '', status: 'error',
      error: error instanceof PresentationError ? error.presentation : messageText('sessionWorkbenchUi.attachmentFailure.capture') }],
  }, true);
  const known = files.reduce((sum, file) => sum + file.size, 0);
  let reservation: number;
  try {
    if (previous.length + files.length + (discover ? 1 : 0) > IMAGE_LIMITS.count) throw attachmentError('count');
    const oversized = files.find((file) => file.size > IMAGE_LIMITS.imageBytes);
    if (oversized) throw attachmentError('imageBytes', { bytes: oversized.size });
    const global = composerImageUsage();
    const available = Math.min(
      IMAGE_LIMITS.draftBytes - composerImageUsage(key).originalBytes,
      IMAGE_LIMITS.totalBytes - global.originalBytes,
      IMAGE_LIMITS.captureBytes - global.captureBytes,
    );
    reservation = discover ? available : known;
    if (available <= 0 || reservation > available || known > reservation) {
      throw attachmentError(global.captureBytes > 0 ? 'captureBusy' : 'budget');
    }
  } catch (error) { fail(error); return; }

  const controller = new AbortController();
  let resolve!: (result: Awaited<ImageCaptureTask['done']>) => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<Awaited<ImageCaptureTask['done']>>((yes, no) => { resolve = yes; reject = no; });
  // The draft displays the failure even when nobody has clicked Send.
  void done.catch(() => undefined);
  const batch: CaptureReservation = { key, bytes: reservation, controller, done };
  captures.add(batch);
  const directItems = files.map((file) => ({ id: attachmentId(), name: file.name }));
  const discoveryId = attachmentId();
  const placeholders: AttachmentImage[] = [
    ...directItems.map((item): AttachmentImage => ({ ...item, status: 'capturing', capture: batch })),
    ...(discover ? [{ id: discoveryId, name: '', status: 'capturing' as const, capture: batch }] : []),
  ];
  updateAttachments(key, { ...current, images: [...previous, ...placeholders] }, true);

  const guard = <T,>(promise: Promise<T>): Promise<T> => promise.catch((error: unknown) => {
    controller.abort(error);
    throw error;
  });
  const direct = files.map((file, index) => guard(captureFile(file, controller.signal).then((blob): ReadyAttachmentImage => ({
    ...directItems[index]!, status: 'ready', blob,
  }))));
  // Invoke discovery now as well; no queued File or delayed system-clipboard read.
  let discovery: Promise<ClipboardAttachmentDescriptor[]>;
  try { discovery = discover ? guard(discover()) : Promise.resolve([]); }
  catch (error) { discovery = guard(Promise.reject(error)); }
  const sources = guard((async () => {
    const descriptors = await discovery;
    try {
      controller.signal.throwIfAborted();
      const imageSources = descriptors.filter((item) => item.kind === 'image')
        .filter((item) => !files.some((file) => file.name === item.name && file.size === item.size));
      if (previous.length + directItems.length + imageSources.length > IMAGE_LIMITS.count) throw attachmentError('count');
      const oversized = imageSources.find((item) => item.size > IMAGE_LIMITS.imageBytes);
      if (oversized) throw attachmentError('imageBytes', { bytes: oversized.size });
      if (known + imageSources.reduce((sum, item) => sum + item.size, 0) > reservation) throw attachmentError('batchBytes');
      const sourceItems = imageSources.map((item, index) => ({ id: index === 0 ? discoveryId : attachmentId(), name: item.name }));
      if (discover && sourceItems.length > 0) {
        const live = getComposerAttachments(key);
        updateAttachments(key, { ...live, images: live.images.flatMap((image) => image.id === discoveryId
          ? sourceItems.map((item): AttachmentImage => ({ ...item, status: 'capturing', capture: batch })) : [image]) });
      }
      const images: ReadyAttachmentImage[] = [];
      let remaining = reservation - known;
      for (const [index, descriptor] of imageSources.entries()) {
        const blob = await captureSource(descriptor.previewUrl, Math.min(IMAGE_LIMITS.imageBytes, remaining), controller.signal);
        images.push({ ...sourceItems[index]!, status: 'ready', blob });
        remaining -= blob.size;
      }
      const paths = new Set(getComposerAttachments(key).files.map((file) => file.path));
      const textFiles: AttachmentFile[] = [];
      for (const descriptor of descriptors) {
        if (descriptor.kind !== 'file' || !isTextAttachment(descriptor.name) || paths.has(descriptor.path)) continue;
        if (paths.size >= IMAGE_LIMITS.count) throw attachmentError('count');
        paths.add(descriptor.path);
        textFiles.push({ id: attachmentId(), name: descriptor.name, path: descriptor.path });
      }
      return { images, files: textFiles };
    } finally {
      const releases = await Promise.allSettled(descriptors.map((descriptor) => descriptor.kind === 'image'
        ? window.piskie.desktop.files.releasePreview(descriptor.previewUrl) : undefined));
      const failed = releases.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
  })());

  void (async () => {
    const results = await Promise.allSettled([...direct, sources]);
    // All source readers and source tokens have settled before the reservation is returned.
    captures.delete(batch);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure || controller.signal.aborted) {
      const error = controller.signal.reason ?? (failure?.status === 'rejected' ? failure.reason : attachmentError('capture'));
      const live = getComposerAttachments(key);
      const retained = live.images.filter((image) => image.status === 'capturing' && image.capture === batch);
      if (retained.length > 0) updateAttachments(key, {
        ...live,
        images: [...live.images.filter((image) => !retained.includes(image)), {
          id: retained[0]!.id, name: retained[0]!.name, status: 'error',
          error: error instanceof PresentationError ? error.presentation : messageText('sessionWorkbenchUi.attachmentFailure.capture'),
        }],
      });
      reject(error);
      return;
    }
    const captured = results.slice(0, direct.length).map((result) => (result as PromiseFulfilledResult<ReadyAttachmentImage>).value);
    const imported = (results[direct.length] as PromiseFulfilledResult<Awaited<typeof sources>>).value;
    const images = [...captured, ...imported.images];
    const live = getComposerAttachments(key);
    const replacements = new Map(images.map((image) => [image.id, image]));
    // Transfer selected batches at publication, including batches finishing out of order.
    // The completion Promise carries no original bytes after this handoff.
    for (const consumer of consumers) {
      let replaced = false;
      const selection = consumer.images.flatMap((image) => {
        if (image.status !== 'capturing' || image.capture !== batch) return [image];
        if (replaced) return [];
        replaced = true;
        return images;
      });
      if (replaced) {
        consumer.images.splice(0, consumer.images.length, ...selection);
        consumer.files?.push(...imported.files);
      }
    }
    updateAttachments(key, {
      images: live.images.flatMap((image) => image.status === 'capturing' && image.capture === batch
        ? (replacements.get(image.id) ? [replacements.get(image.id)!] : []) : [image]),
      files: [...live.files, ...imported.files],
    });
    resolve();
  })();
}

let sendTail: Promise<unknown> = Promise.resolve();
const submittingDrafts = new Set<string>();

/** Keeps original-image ownership and the renderer send channel until delivery settles. */
export async function withAttachmentSubmission<T>(
  key: string,
  submit: (images: ImagePayload[] | undefined, files: readonly AttachmentFile[]) => Promise<T>,
): Promise<T> {
  if (submittingDrafts.has(key)) throw attachmentError('preparing');
  submittingDrafts.add(key);
  const version = getComposerDraftVersion(key);
  const controller = new AbortController();
  const selected = [...getComposerAttachments(key).images];
  const selectedFiles = [...getComposerAttachments(key).files];
  const pending = new Set(selected.flatMap((image) => image.status === 'capturing' ? [image.capture] : []));
  const consumer = { key, images: selected, files: selectedFiles };
  consumers.add(consumer);
  let delivering = false;
  const check = () => {
    if (delivering) return;
    const live = getComposerAttachments(key);
    if (getComposerDraftVersion(key) !== version
      || selected.some((image) => !live.images.some((current) => current.id === image.id))
      || selectedFiles.some((file) => !live.files.some((current) => current.id === file.id))
      || [...pending].some((capture) => capture.controller.signal.aborted)) controller.abort(attachmentError('cancelled'));
  };
  const unsubscribe = useComposerDraftStore.subscribe(check);
  try {
    const failed = selected.find((image) => image.status === 'error');
    if (failed?.status === 'error') throw new PresentationError(failed.error);
    check();
    controller.signal.throwIfAborted();
    if (pending.size > 0) {
      // Cancellation stops waiting without retaining completed images behind a slow batch.
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', cancel, { once: true });
        void Promise.all([...pending].map((capture) => capture.done)).then(() => resolve(), reject).finally(() => {
          controller.signal.removeEventListener('abort', cancel);
        });
      });
    }
    check();
    controller.signal.throwIfAborted();
    if (selected.length === 0) {
      delivering = true;
      return await submit(undefined, selectedFiles);
    }
    const operation = sendTail.then(async () => {
      check();
      controller.signal.throwIfAborted();
      let payloads: ImagePayload[] | undefined = [];
      try {
        for (const image of selected) {
          if (image.status === 'ready') payloads.push(await blobToImagePayload(image.blob, image.blob.type, controller.signal));
        }
        check();
        controller.signal.throwIfAborted();
        delivering = true;
        return await submit(payloads, selectedFiles);
      } finally { payloads = undefined; }
    });
    sendTail = operation.then(() => undefined, () => undefined);
    return await operation;
  } finally {
    unsubscribe();
    consumers.delete(consumer);
    selected.length = 0;
    submittingDrafts.delete(key);
  }
}

export async function submitComposerDraft(
  key: string,
  submit: (draft: ComposerDraftValue, images: ImagePayload[] | undefined, files: readonly AttachmentFile[]) => Promise<boolean>,
): Promise<boolean> {
  const draft = useComposerDraftStore.getState().drafts[key] ?? emptyDraft();
  const version = getComposerDraftVersion(key);
  const ok = await withAttachmentSubmission(key, (images, files) => submit(draft, images, files));
  if (ok && getComposerDraftVersion(key) === version && useComposerDraftStore.getState().drafts[key]?.edit === draft.edit) {
    useComposerDraftStore.getState().resetDraft(key);
  }
  return ok;
}

export type AttachmentPreviewOpener = (url: string, contextUrls?: readonly string[], index?: number, release?: () => void) => void;
const imagePreviews = new Set<() => void>();

export function openAttachmentImage(image: ReadyAttachmentImage, show: AttachmentPreviewOpener): void {
  const key = Object.entries(useComposerDraftStore.getState().drafts)
    .find(([, draft]) => draft.attachments.images.includes(image))?.[0];
  if (key === undefined) return;
  const consumer = { key, images: [image] };
  const url = URL.createObjectURL(image.blob);
  consumers.add(consumer);
  const release = () => {
    if (!imagePreviews.delete(release)) return;
    URL.revokeObjectURL(url);
    consumers.delete(consumer);
  };
  imagePreviews.add(release);
  try { show(url, undefined, undefined, release); } catch (error) { release(); throw error; }
}

export type ThumbnailResult = { readonly kind: 'ready'; readonly blob: Blob; readonly url: string }
  | { readonly kind: 'error'; readonly error: PresentationText };
interface ThumbnailEntry {
  readonly listeners: Set<(value: ThumbnailResult | undefined) => void>;
  result?: ThumbnailResult;
}
const thumbnails = new Map<ReadyAttachmentImage, ThumbnailEntry>();
let thumbnailTail: Promise<void> = Promise.resolve();

function releaseThumbnail(image: ReadyAttachmentImage): void {
  const entry = thumbnails.get(image);
  if (!entry) return;
  if (entry.result?.kind === 'ready') URL.revokeObjectURL(entry.result.url);
  thumbnails.delete(image);
  for (const listener of entry.listeners) listener(undefined);
}

/** Visible consumers pin derived previews; inactive previews may be evicted without touching originals. */
export function observeAttachmentThumbnail(
  image: ReadyAttachmentImage,
  listener: (value: ThumbnailResult | undefined) => void,
): () => void {
  const key = Object.entries(useComposerDraftStore.getState().drafts)
    .find(([, draft]) => draft.attachments.images.includes(image))?.[0];
  if (key === undefined) return () => undefined;
  let entry = thumbnails.get(image);
  if (!entry) {
    entry = { listeners: new Set() };
    thumbnails.set(image, entry);
    const owned = entry;
    const consumer = { key, images: [image] };
    consumers.add(consumer);
    thumbnailTail = thumbnailTail.then(async () => {
      try {
        if (thumbnails.get(image) !== owned) return;
        const blob = await createImageThumbnail(image.blob);
        if (thumbnails.get(image) !== owned) return;
        for (const [candidate, cached] of thumbnails) {
          if (composerImageUsage().thumbnailBytes + blob.size <= IMAGE_LIMITS.thumbnailBytes) break;
          if (cached.listeners.size === 0) releaseThumbnail(candidate);
        }
        if (composerImageUsage().thumbnailBytes + blob.size > IMAGE_LIMITS.thumbnailBytes) throw attachmentError('thumbnail');
        owned.result = { kind: 'ready', blob, url: URL.createObjectURL(blob) };
      } catch (error) {
        if (thumbnails.get(image) === owned) owned.result = {
          kind: 'error', error: presentationFromError(error, messageText('sessionWorkbenchUi.attachmentFailure.thumbnail')),
        };
      } finally {
        consumers.delete(consumer);
      }
      if (thumbnails.get(image) === owned) for (const notify of owned.listeners) notify(owned.result);
    });
  }
  entry.listeners.add(listener);
  listener(entry.result);
  return () => { entry.listeners.delete(listener); };
}
