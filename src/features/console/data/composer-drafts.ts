/**
 * 输入草稿按投递目标驻留在 renderer 内存中。文字、附件描述和图片资源共享同一个
 * owner，因此切会话、切模式或输入组件临时卸载后都能恢复；发送成功时再清空。
 */

import { useCallback } from 'react';
import { create } from 'zustand';

import type {
  AttachmentFile,
  AttachmentImage,
  ImagePayload,
} from '../attachments/model';

export type ComposerAttachmentImageResource =
  | {
      readonly kind: 'blob';
      readonly blob: Blob;
      readonly sourcePath?: string;
      readonly objectUrl: string;
      encoded?: Promise<ImagePayload>;
    }
  | {
      readonly kind: 'url';
      readonly url: string;
      readonly sourcePath: string;
      encoded?: Promise<ImagePayload>;
    };

export interface ComposerAttachmentState {
  readonly images: readonly AttachmentImage[];
  readonly files: readonly AttachmentFile[];
  readonly imageResources: ReadonlyMap<string, ComposerAttachmentImageResource>;
}

interface ComposerDraftValue {
  readonly text: string;
  readonly attachments: ComposerAttachmentState;
}

interface ComposerImageAddition {
  readonly image: AttachmentImage;
  readonly resource: ComposerAttachmentImageResource;
}

const EMPTY_ATTACHMENTS: ComposerAttachmentState = Object.freeze({
  images: Object.freeze([]),
  files: Object.freeze([]),
  imageResources: new Map(),
});

function emptyDraft(): ComposerDraftValue {
  return { text: '', attachments: EMPTY_ATTACHMENTS };
}

function hasAttachments(attachments: ComposerAttachmentState): boolean {
  return attachments.images.length > 0 || attachments.files.length > 0;
}

function disposeImageResource(resource: ComposerAttachmentImageResource | undefined): void {
  if (resource?.kind === 'blob') URL.revokeObjectURL(resource.objectUrl);
}

function disposeImageResources(resources: ReadonlyMap<string, ComposerAttachmentImageResource>): void {
  for (const resource of resources.values()) disposeImageResource(resource);
}

export interface ComposerDraftStore {
  readonly drafts: Readonly<Record<string, ComposerDraftValue>>;
  readonly setDraft: (key: string, text: string) => void;
  readonly appendImages: (key: string, additions: readonly ComposerImageAddition[]) => void;
  readonly appendFiles: (key: string, additions: readonly AttachmentFile[]) => void;
  readonly removeAttachment: (key: string, id: string) => void;
  readonly clearAttachments: (key: string) => void;
}

export const useComposerDraftStore = create<ComposerDraftStore>((set) => ({
  drafts: {},

  setDraft: (key, text) => set((state) => {
    const current = state.drafts[key] ?? emptyDraft();
    if (current.text === text) return state;

    const drafts = { ...state.drafts };
    if (text === '' && !hasAttachments(current.attachments)) {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, text };
    }
    return { drafts };
  }),

  appendImages: (key, additions) => set((state) => {
    if (additions.length === 0) return state;
    const current = state.drafts[key] ?? emptyDraft();
    const imageResources = new Map(current.attachments.imageResources);
    for (const addition of additions) imageResources.set(addition.image.id, addition.resource);
    return {
      drafts: {
        ...state.drafts,
        [key]: {
          ...current,
          attachments: {
            ...current.attachments,
            images: [...current.attachments.images, ...additions.map(({ image }) => image)],
            imageResources,
          },
        },
      },
    };
  }),

  appendFiles: (key, additions) => set((state) => {
    if (additions.length === 0) return state;
    const current = state.drafts[key] ?? emptyDraft();
    return {
      drafts: {
        ...state.drafts,
        [key]: {
          ...current,
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

    const resource = current.attachments.imageResources.get(id);
    const images = current.attachments.images.filter((image) => image.id !== id);
    const files = current.attachments.files.filter((file) => file.id !== id);
    if (!resource && images.length === current.attachments.images.length && files.length === current.attachments.files.length) {
      return state;
    }

    disposeImageResource(resource);
    const imageResources = new Map(current.attachments.imageResources);
    imageResources.delete(id);
    const attachments = { images, files, imageResources };
    const drafts = { ...state.drafts };
    if (current.text === '' && !hasAttachments(attachments)) {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, attachments };
    }
    return { drafts };
  }),

  clearAttachments: (key) => set((state) => {
    const current = state.drafts[key];
    if (current) disposeImageResources(current.attachments.imageResources);

    const drafts = { ...state.drafts };
    if (!current || current.text === '') {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, attachments: EMPTY_ATTACHMENTS };
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
  const setForKey = useCallback((text: string) => setDraft(key, text), [key, setDraft]);
  return [value, setForKey];
}

export function useComposerAttachments(key: string): ComposerAttachmentState {
  return useComposerDraftStore((state) => state.drafts[key]?.attachments ?? EMPTY_ATTACHMENTS);
}

export function getComposerAttachments(key: string): ComposerAttachmentState {
  return useComposerDraftStore.getState().drafts[key]?.attachments ?? EMPTY_ATTACHMENTS;
}

export function clearAllComposerDrafts(): void {
  const state = useComposerDraftStore.getState();
  for (const draft of Object.values(state.drafts)) {
    disposeImageResources(draft.attachments.imageResources);
  }
  useComposerDraftStore.setState({ drafts: {} });
}

export function composerDraftKey(agentId: string, workerId?: string): string {
  return workerId ? `worker:${agentId}:${workerId}` : `agent:${agentId}`;
}
